//! The injected-time alarm scheduler: one deterministic state machine over
//! the durable store.
//!
//! Authority flows only from committed Actions: `apply` validates and
//! persists a committed command into an `AlarmRecord`, `Occurrence`, or
//! claim; `claim_due`/`complete`/`release` walk a due occurrence through the
//! claim lifecycle with finite leases and compare-and-set; `settle` performs
//! the deterministic recovery pass (expired-claim reconciliation, tzdb
//! recomputation, misfire partition, horizon roll, retention prune) with the
//! injected clock and versioned tzdb rules. The wakeup premise is derived
//! state — the clock and wakeup never create Action authority.

use crate::action::{ActionCommand, CommittedAction, parse_command, validate_committed};
use crate::clock::Clock;
use crate::error::{AlarmError, AlarmErrorCode};
use crate::failpoint::{Failpoint, FailpointBoundary};
use crate::occurrence::{
    Schedule, next_after, occurrence_id, repeat_identity, snooze_identity, window_occurrences,
};
use crate::record::{
    AlarmRecord, DeliveryShape, FrozenAlarmConfig, MisfirePolicy, ScheduleShape,
    normalize_delivery, normalize_schedule, validate_alarm_id, validate_title,
};
use crate::store::{
    AlarmRow, AlarmRowUpdate, AlarmStore, Claim, MisfireBasis, NewOccurrence, Occurrence,
    OccurrenceKind, OccurrenceState, due_occurrences_tx, get_alarm_tx, get_occurrence_tx,
    insert_occurrence_tx, occurrence_from_row, recompute_next_tx, record_action_log_tx,
    record_diagnostic_tx, update_alarm_fields_tx, update_occurrence_state_tx,
};
use crate::time::{US_PER_SECOND, UsInstant, format_utc_iso6, parse_utc_timestamp_us};
use crate::tzdb::{ZoneRulesProvider, zone_rules_id};
use rusqlite::params;
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

/// Runtime Activation outcome for an expired claim, per Alarm spec §8.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    NotApplied,
    Applied,
    Unknown,
}

/// A typed wakeup premise: the exact instant plus a stable key derived from
/// durable state. Never an Action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakeupPremise {
    pub at_us: UsInstant,
    pub key: String,
}

/// The typed output premise produced by a committed completion — a single
/// ordered alarm event. Channel delivery and BlockDraft assembly belong to
/// the runtime bridge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FiredEvent {
    pub occurrence_id: String,
    pub alarm_id: String,
    pub alarm_revision: u64,
    pub title: String,
    pub kind: OccurrenceKind,
    pub repeat_ordinal: u64,
    pub scheduled_at: String,
    pub scheduled_us: UsInstant,
    pub fired_at: String,
    pub lateness_us: UsInstant,
    pub misfire_status: Option<MisfireBasis>,
    pub ack_required: bool,
}

impl FiredEvent {
    fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// Outcome of a deterministic recovery pass.
#[derive(Debug, Clone, Default)]
pub struct SettleReport {
    /// Expired claims the runtime confirmed Applied (marked FIRED).
    pub reconciled_applied: Vec<String>,
    /// Expired claims returned to DUE after the runtime reported NotApplied.
    pub reconciled_reopened: Vec<String>,
    /// Expired claims left CLAIMED because the runtime outcome was Unknown.
    pub reconciled_unknown: Vec<String>,
    /// Alarms settled (misfire/roll pass completed).
    pub alarms_settled: u64,
}

/// Bounds the eager occurrence roll within one wakeup window.
const ROLL_BATCH_ROWS: usize = 1024;

/// The single injected-time scheduler.
pub struct Scheduler {
    store: AlarmStore,
    clock: Box<dyn Clock>,
    zones: Box<dyn ZoneRulesProvider>,
    config: FrozenAlarmConfig,
    failpoint: Option<Failpoint>,
}

impl Scheduler {
    pub fn open(
        path: &Path,
        clock: Box<dyn Clock>,
        zones: Box<dyn ZoneRulesProvider>,
        config: FrozenAlarmConfig,
    ) -> Result<Self, AlarmError> {
        let store = AlarmStore::open(path, 5000)?;
        Ok(Self::new(store, clock, zones, config))
    }

    pub fn open_in_memory(
        clock: Box<dyn Clock>,
        zones: Box<dyn ZoneRulesProvider>,
        config: FrozenAlarmConfig,
    ) -> Result<Self, AlarmError> {
        let store = AlarmStore::open_in_memory()?;
        Ok(Self::new(store, clock, zones, config))
    }

    fn new(
        store: AlarmStore,
        clock: Box<dyn Clock>,
        zones: Box<dyn ZoneRulesProvider>,
        config: FrozenAlarmConfig,
    ) -> Self {
        Self {
            store,
            clock,
            zones,
            config,
            failpoint: None,
        }
    }

    pub fn store(&self) -> &AlarmStore {
        &self.store
    }

    pub fn config(&self) -> &FrozenAlarmConfig {
        &self.config
    }

    pub fn set_failpoint(&mut self, failpoint: Option<Failpoint>) {
        self.failpoint = failpoint;
    }

    /// Install an upgraded tzdb revision and its rules provider; a later
    /// `settle` deterministically recomputes future, not already-fired,
    /// occurrences (Alarm spec §1).
    pub fn upgrade_tzdb(&mut self, revision: String, zones: Box<dyn ZoneRulesProvider>) {
        self.config.tzdb_revision = revision;
        self.zones = zones;
    }

    pub fn now(&self) -> Result<UsInstant, AlarmError> {
        self.clock.now_us()
    }

    fn fp(&self) -> Option<Failpoint> {
        self.failpoint.clone()
    }

    fn build_schedule(&self, alarm: &AlarmRow) -> Result<Schedule, AlarmError> {
        match &alarm.schedule_shape {
            ScheduleShape::Once { at } => {
                let at_us = parse_utc_timestamp_us(at, "record.at")?;
                Ok(Schedule::Once { at_us })
            }
            ScheduleShape::Interval {
                every_seconds,
                anchor,
            } => {
                let anchor_us = parse_utc_timestamp_us(anchor, "record.anchor")?;
                let every_us = i64::try_from(*every_seconds)
                    .ok()
                    .and_then(|s| s.checked_mul(US_PER_SECOND))
                    .ok_or_else(|| {
                        AlarmError::new(
                            AlarmErrorCode::InvalidSchedule,
                            "interval duration overflow",
                        )
                    })?;
                Ok(Schedule::Interval {
                    every_us,
                    anchor_us,
                })
            }
            ScheduleShape::CronV1 {
                expression,
                timezone,
            } => {
                let zone_id = zone_rules_id(timezone, &alarm.tzdb_revision);
                let zone = self.zones.zone(&zone_id)?;
                Ok(Schedule::Cron {
                    expression: expression.clone(),
                    zone: Some(zone),
                    gap_policy: alarm.dst_gap_policy,
                    fold_policy: alarm.dst_fold_policy,
                })
            }
        }
    }

    fn alarm_row_from_record(
        &self,
        record: &AlarmRecord,
        action_id: &str,
        now: UsInstant,
    ) -> AlarmRow {
        AlarmRow {
            alarm_id: record.alarm_id.clone(),
            revision: record.revision,
            title: record.title.clone(),
            schedule_shape: record.schedule.clone(),
            delivery_shape: record.delivery.clone(),
            misfire_policy: record.misfire_policy,
            dst_gap_policy: record.dst_gap_policy,
            dst_fold_policy: record.dst_fold_policy,
            enabled: record.enabled,
            created_at: record.created_at.clone(),
            next_occurrence: record.next_occurrence.clone(),
            tzdb_revision: record.tzdb_revision.clone(),
            config_revision: self.config.revision.clone(),
            authority: self.config.authority.clone(),
            action_id: action_id.to_string(),
            updated_at: format_utc_iso6(now),
            deleted: false,
        }
    }

    // ------------------------------------------------------------------
    // Committed command application
    // ------------------------------------------------------------------

    /// Apply a committed Alarm Action and return its typed result. Replay of
    /// an already-applied action returns the recorded result unchanged.
    pub fn apply(&mut self, action: &CommittedAction) -> Result<serde_json::Value, AlarmError> {
        validate_committed(action)?;
        if let Some(recorded) = self.store.recorded_action(&action.action_id)? {
            return Ok(recorded.result_json);
        }
        let now = self.now()?;
        let command = parse_command(action)?;
        let value = match command {
            ActionCommand::Create(args) => self.apply_create(action, args, now)?,
            ActionCommand::List(args) => self.apply_list(action, args)?,
            ActionCommand::Get(args) => self.apply_get(action, args)?,
            ActionCommand::Update(args) => self.apply_update(action, args, now)?,
            ActionCommand::Delete(args) => self.apply_delete(action, args, now)?,
            ActionCommand::Snooze(args) => self.apply_snooze(action, args, now)?,
            ActionCommand::Acknowledge(args) => self.apply_acknowledge(action, args, now)?,
        };
        Ok(value)
    }

    /// Materialize a create/update replacement into a record and a parsed
    /// schedule under the frozen config revision.
    fn normalize_create_args(
        &self,
        args: &crate::action::CreateArgs,
    ) -> Result<(AlarmRecord, Schedule), AlarmError> {
        validate_title(&args.title)?;
        let (schedule_shape, schedule) =
            normalize_schedule(&args.schedule, &self.config, self.zones.as_ref())?;
        let delivery = normalize_delivery(&args.delivery, &self.config)?;
        let gap = args
            .dst_gap_policy
            .unwrap_or(self.config.default_dst_gap_policy);
        let fold = args
            .dst_fold_policy
            .unwrap_or(self.config.default_dst_fold_policy);
        let misfire = args
            .misfire_policy
            .unwrap_or(self.config.default_misfire_policy);
        Ok((
            AlarmRecord {
                alarm_id: String::new(),
                revision: 1,
                title: args.title.clone(),
                schedule: schedule_shape,
                delivery,
                misfire_policy: misfire,
                dst_gap_policy: gap,
                dst_fold_policy: fold,
                enabled: args.enabled,
                created_at: String::new(),
                next_occurrence: None,
                tzdb_revision: self.config.tzdb_revision.clone(),
            },
            schedule,
        ))
    }

    fn apply_create(
        &mut self,
        action: &CommittedAction,
        args: crate::action::CreateArgs,
        now: UsInstant,
    ) -> Result<serde_json::Value, AlarmError> {
        // The Alarm extension owns the creation namespace; the alarm identity
        // is derived deterministically from the committed action so replay and
        // restart converge on the same record.
        let alarm_id = derive_alarm_id(&action.action_id);
        if self.store.count_active_alarms()? >= self.config.max_alarms {
            return Err(AlarmError::new(
                AlarmErrorCode::AlarmLimit,
                "maximum number of alarms reached",
            ));
        }
        let (mut record, schedule) = self.normalize_create_args(&args)?;
        let next = next_after(&schedule, now)?;
        record.alarm_id = alarm_id.clone();
        record.created_at = format_utc_iso6(now);
        record.next_occurrence = next.map(|o| format_utc_iso6(o.scheduled_us));
        let row = self.alarm_row_from_record(&record, &action.action_id, now);
        let mut occurrences: Vec<NewOccurrence> = Vec::new();
        let mut ats: Vec<String> = Vec::new();
        if record.enabled {
            if let Some(next) = next {
                occurrences.push(NewOccurrence {
                    occurrence_id: occurrence_id(
                        &alarm_id,
                        record.revision,
                        next.scheduled_us,
                        next.fold_ordinal,
                    ),
                    scheduled_us: next.scheduled_us,
                    fold_ordinal: next.fold_ordinal,
                    kind: OccurrenceKind::Scheduled,
                    repeat_ordinal: 0,
                    parent_occurrence_id: None,
                });
                ats.push(format_utc_iso6(next.scheduled_us));
            }
        }
        let result = serde_json::json!({
            "schema": "dolly.alarm.create-result/v1",
            "record": record,
        });
        self.store.write_alarm_with_occurrences(
            self.fp().as_ref(),
            FailpointBoundary::BeforeCreate,
            &action.action_id,
            &action.name,
            now,
            &row,
            &occurrences,
            &ats,
            &result,
        )?;
        Ok(result)
    }

    fn apply_list(
        &mut self,
        _action: &CommittedAction,
        args: crate::action::ListArgs,
    ) -> Result<serde_json::Value, AlarmError> {
        if !(1..=1000).contains(&args.limit) {
            return Err(AlarmError::new(
                AlarmErrorCode::InvalidSchedule,
                "limit must be an integer in [1, 1000]",
            ));
        }
        let cursor = decode_list_cursor(args.cursor.as_deref())?;
        if let Some(cursor) = &cursor {
            if cursor.enabled != args.enabled || cursor.config_revision != self.config.revision {
                return Err(AlarmError::new(
                    AlarmErrorCode::InvalidSchedule,
                    "list cursor is not valid for this filter and snapshot revision",
                ));
            }
        }
        let all = self.store.list_alarms(args.enabled)?;
        let start = cursor
            .as_ref()
            .map(|c| {
                all.iter()
                    .position(|row| {
                        row.alarm_id == c.alarm_id
                            && row.next_occurrence.as_deref() == c.next.as_deref()
                    })
                    .map(|index| index + 1)
                    .unwrap_or(all.len())
            })
            .unwrap_or(0);
        let page: Vec<AlarmRow> = all
            .iter()
            .skip(start)
            .take(args.limit as usize)
            .cloned()
            .collect();
        let next_cursor = if page.len() == args.limit as usize && start + page.len() < all.len() {
            let last = page.last().unwrap();
            Some(encode_list_cursor(ListCursor {
                config_revision: self.config.revision.clone(),
                enabled: args.enabled,
                next: last.next_occurrence.clone(),
                alarm_id: last.alarm_id.clone(),
            }))
        } else {
            None
        };
        let records: Vec<AlarmRecord> = page.iter().map(|row| row.record()).collect();
        Ok(serde_json::json!({
            "schema": "dolly.alarm.list-result/v1",
            "records": records,
            "next_cursor": next_cursor,
        }))
    }

    fn apply_get(
        &mut self,
        _action: &CommittedAction,
        args: crate::action::GetArgs,
    ) -> Result<serde_json::Value, AlarmError> {
        validate_alarm_id(&args.alarm_id)?;
        let alarm = self
            .store
            .get_alarm(&args.alarm_id)?
            .ok_or_else(|| alarm_not_found(&args.alarm_id))?;
        if alarm.deleted {
            return Err(alarm_not_found(&args.alarm_id));
        }
        Ok(serde_json::json!({
            "schema": "dolly.alarm.get-result/v1",
            "record": alarm.record(),
        }))
    }

    fn apply_update(
        &mut self,
        action: &CommittedAction,
        args: crate::action::UpdateArgs,
        now: UsInstant,
    ) -> Result<serde_json::Value, AlarmError> {
        validate_alarm_id(&args.alarm_id)?;
        let (record, schedule) = self.normalize_create_args(&args.replacement)?;
        let now_at = format_utc_iso6(now);
        let schedule_json = serde_json::to_string(&record.schedule).unwrap_or_default();
        let delivery_json = serde_json::to_string(&record.delivery).unwrap_or_default();
        let alarm_id = args.alarm_id.clone();
        let action_id = action.action_id.clone();
        let action_name = action.name.clone();
        let enabled = record.enabled;
        let expected = args.expected_revision;
        let horizon = self.config.wakeup_horizon_seconds;
        let result =
            self.store
                .effect(self.fp().as_ref(), FailpointBoundary::BeforeUpdate, |tx| {
                    let alarm =
                        get_alarm_tx(tx, &alarm_id)?.ok_or_else(|| alarm_not_found(&alarm_id))?;
                    if alarm.deleted {
                        return Err(alarm_not_found(&alarm_id));
                    }
                    if alarm.revision != expected {
                        return Err(revision_conflict(&alarm_id, expected));
                    }
                    let new_revision = alarm.revision + 1;
                    let fields = AlarmRowUpdate {
                        title: Some(record.title.clone()),
                        schedule_json: Some(schedule_json),
                        delivery_json: Some(delivery_json),
                        misfire_policy: Some(record.misfire_policy.as_str().to_string()),
                        dst_gap_policy: Some(record.dst_gap_policy.as_str().to_string()),
                        dst_fold_policy: Some(record.dst_fold_policy.as_str().to_string()),
                        enabled: Some(record.enabled),
                        tzdb_revision: Some(self.config.tzdb_revision.clone()),
                        config_revision: Some(self.config.revision.clone()),
                        authority: Some(self.config.authority.clone()),
                        action_id: Some(action_id.clone()),
                        revision_bump: true,
                        updated_at: Some(now_at.clone()),
                        ..Default::default()
                    };
                    let changed = update_alarm_fields_tx(tx, &alarm_id, alarm.revision, &fields)?;
                    if !changed {
                        return Err(revision_conflict(&alarm_id, expected));
                    }
                    // Disable future claims for the old revision, preserving history.
                    suppress_due_tx(tx, &alarm_id, Some(alarm.revision), "superseded")?;
                    if enabled {
                        roll_occurrences_tx(
                            tx,
                            &alarm_id,
                            new_revision,
                            &schedule,
                            now,
                            &now_at,
                            horizon,
                        )?;
                    }
                    recompute_next_tx(tx, &alarm_id, now, true)?;
                    let fresh =
                        get_alarm_tx(tx, &alarm_id)?.ok_or_else(|| alarm_not_found(&alarm_id))?;
                    let result = serde_json::json!({
                        "schema": "dolly.alarm.update-result/v1",
                        "record": fresh.record(),
                    });
                    record_action_log_tx(
                        tx,
                        &action_id,
                        &action_name,
                        &result,
                        Some(&alarm_id),
                        &now_at,
                    )?;
                    Ok(result)
                })?;
        Ok(result)
    }

    fn apply_delete(
        &mut self,
        action: &CommittedAction,
        args: crate::action::DeleteArgs,
        now: UsInstant,
    ) -> Result<serde_json::Value, AlarmError> {
        validate_alarm_id(&args.alarm_id)?;
        let now_at = format_utc_iso6(now);
        let alarm_id = args.alarm_id.clone();
        let action_id = action.action_id.clone();
        let action_name = action.name.clone();
        let expected = args.expected_revision;
        let result =
            self.store
                .effect(self.fp().as_ref(), FailpointBoundary::BeforeDelete, |tx| {
                    let alarm =
                        get_alarm_tx(tx, &alarm_id)?.ok_or_else(|| alarm_not_found(&alarm_id))?;
                    if alarm.deleted {
                        return Err(alarm_not_found(&alarm_id));
                    }
                    if alarm.revision != expected {
                        return Err(revision_conflict(&alarm_id, expected));
                    }
                    let fields = AlarmRowUpdate {
                        deleted: Some(true),
                        next_occurrence: Some(None),
                        action_id: Some(action_id.clone()),
                        updated_at: Some(now_at.clone()),
                        ..Default::default()
                    };
                    let changed = update_alarm_fields_tx(tx, &alarm_id, alarm.revision, &fields)?;
                    if !changed {
                        return Err(revision_conflict(&alarm_id, expected));
                    }
                    // Disable future claims for every revision, preserving history.
                    suppress_due_tx(tx, &alarm_id, None, "deleted")?;
                    let result = serde_json::json!({
                        "schema": "dolly.alarm.delete-result/v1",
                        "alarm_id": alarm_id,
                        "deleted_alarm_revision": alarm.revision,
                    });
                    record_action_log_tx(
                        tx,
                        &action_id,
                        &action_name,
                        &result,
                        Some(&alarm_id),
                        &now_at,
                    )?;
                    Ok(result)
                })?;
        Ok(result)
    }

    fn apply_snooze(
        &mut self,
        action: &CommittedAction,
        args: crate::action::SnoozeArgs,
        now: UsInstant,
    ) -> Result<serde_json::Value, AlarmError> {
        validate_alarm_id(&args.alarm_id)?;
        let new_at_us = parse_utc_timestamp_us(&args.new_at, "new_at")?;
        let now_at = format_utc_iso6(now);
        let alarm_id = args.alarm_id.clone();
        let occurrence_id_arg = args.occurrence_id.clone();
        let action_id = action.action_id.clone();
        let action_name = action.name.clone();
        let expected = args.expected_revision;
        let result =
            self.store
                .effect(self.fp().as_ref(), FailpointBoundary::BeforeSnooze, |tx| {
                    let alarm =
                        get_alarm_tx(tx, &alarm_id)?.ok_or_else(|| alarm_not_found(&alarm_id))?;
                    if alarm.deleted {
                        return Err(alarm_not_found(&alarm_id));
                    }
                    if alarm.revision != expected {
                        return Err(revision_conflict(&alarm_id, expected));
                    }
                    let occurrence = get_occurrence_tx(tx, &occurrence_id_arg)?
                        .ok_or_else(|| occurrence_not_found(&occurrence_id_arg))?;
                    if occurrence.alarm_id != alarm_id {
                        return Err(occurrence_not_found(&occurrence_id_arg));
                    }
                    if occurrence.state != OccurrenceState::Due {
                        return Err(occurrence_not_found(&occurrence_id_arg));
                    }
                    // The source occurrence keeps its historical scheduled instant; it
                    // must not fire.
                    update_occurrence_state_tx(
                        tx,
                        &occurrence.occurrence_id,
                        OccurrenceState::Suppressed,
                        Some("snoozed"),
                        None,
                        None,
                    )?;
                    // One-time child occurrence at the snoozed instant.
                    let child_id = snooze_identity(
                        &alarm_id,
                        &occurrence.occurrence_id,
                        alarm.revision,
                        new_at_us,
                    );
                    let child = NewOccurrence {
                        occurrence_id: child_id,
                        scheduled_us: new_at_us,
                        fold_ordinal: 0,
                        kind: OccurrenceKind::Snooze,
                        repeat_ordinal: 0,
                        parent_occurrence_id: Some(occurrence.occurrence_id.clone()),
                    };
                    insert_occurrence_tx(
                        tx,
                        &child,
                        alarm.revision,
                        &alarm_id,
                        &format_utc_iso6(new_at_us),
                        &now_at,
                    )?;
                    let fields = AlarmRowUpdate {
                        action_id: Some(action_id.clone()),
                        updated_at: Some(now_at.clone()),
                        ..Default::default()
                    };
                    update_alarm_fields_tx(tx, &alarm_id, alarm.revision, &fields)?;
                    recompute_next_tx(tx, &alarm_id, now, true)?;
                    let fresh =
                        get_alarm_tx(tx, &alarm_id)?.ok_or_else(|| alarm_not_found(&alarm_id))?;
                    let result = serde_json::json!({
                        "schema": "dolly.alarm.snooze-result/v1",
                        "snoozed_occurrence_id": occurrence_id_arg,
                        "record": fresh.record(),
                    });
                    record_action_log_tx(
                        tx,
                        &action_id,
                        &action_name,
                        &result,
                        Some(&alarm_id),
                        &now_at,
                    )?;
                    Ok(result)
                })?;
        Ok(result)
    }

    fn apply_acknowledge(
        &mut self,
        action: &CommittedAction,
        args: crate::action::AcknowledgeArgs,
        now: UsInstant,
    ) -> Result<serde_json::Value, AlarmError> {
        validate_alarm_id(&args.alarm_id)?;
        let now_at = format_utc_iso6(now);
        let alarm_id = args.alarm_id.clone();
        let occurrence_id_arg = args.occurrence_id.clone();
        let action_id = action.action_id.clone();
        let action_name = action.name.clone();
        let expected = args.expected_revision;
        let result = self.store.effect(self.fp().as_ref(), FailpointBoundary::BeforeAcknowledge, |tx| {
            let alarm = get_alarm_tx(tx, &alarm_id)?.ok_or_else(|| alarm_not_found(&alarm_id))?;
            if alarm.deleted {
                return Err(alarm_not_found(&alarm_id));
            }
            if alarm.revision != expected {
                return Err(revision_conflict(&alarm_id, expected));
            }
            let occurrence = get_occurrence_tx(tx, &occurrence_id_arg)?
                .ok_or_else(|| occurrence_not_found(&occurrence_id_arg))?;
            if occurrence.alarm_id != alarm_id {
                return Err(occurrence_not_found(&occurrence_id_arg));
            }
            let source_id = occurrence
                .parent_occurrence_id
                .clone()
                .unwrap_or_else(|| occurrence.occurrence_id.clone());
            // Acknowledgement of the original suppresses every repeat; of a
            // repeat, that repeat and every later ordinal.
            let suppress_from = occurrence.repeat_ordinal.max(1);
            let newly_acknowledged = tx
                .execute(
                    "UPDATE occurrences SET ack_state = 'acknowledged', acknowledged_at = ?2
                     WHERE occurrence_id = ?1 AND ack_state IS NULL",
                    params![occurrence_id_arg, now_at],
                )
                .map_err(|e| db_unavailable("ack cas", e))?;
            // Persist the suppression threshold on the source occurrence.
            tx.execute(
                "UPDATE occurrences SET repeat_suppress_from = MIN(COALESCE(repeat_suppress_from, ?2), ?1)
                 WHERE occurrence_id = ?3",
                params![suppress_from as i64, i64::MAX, source_id],
            )
            .map_err(|e| db_unavailable("ack suppress threshold", e))?;
            // Suppress that and all later DUE repeats atomically.
            let _ = tx.execute(
                "UPDATE occurrences SET state = 'suppressed', missed_reason = 'acknowledged',
                    claim_token = NULL, claim_holder = NULL, claim_made_at = NULL,
                    lease_expires_us = NULL
                 WHERE parent_occurrence_id = ?1 AND kind = 'repeat'
                   AND repeat_ordinal >= ?2 AND state = 'due'",
                params![source_id, suppress_from as i64],
            );
            // An acknowledgement committed before the firing suppresses the
            // firing itself; a claim already in flight may still complete.
            let _ = tx.execute(
                "UPDATE occurrences SET state = 'suppressed', missed_reason = 'acknowledged',
                    claim_token = NULL, claim_holder = NULL, claim_made_at = NULL,
                    lease_expires_us = NULL
                 WHERE occurrence_id = ?1 AND state = 'due'",
                params![occurrence_id_arg],
            );
            let acknowledged_at: String = tx
                .query_row(
                    "SELECT acknowledged_at FROM occurrences WHERE occurrence_id = ?1",
                    params![occurrence_id_arg],
                    |r| r.get(0),
                )
                .map_err(|e| db_unavailable("ack read", e))?;
            let result = serde_json::json!({
                "schema": "dolly.alarm.acknowledge-result/v1",
                "alarm_id": alarm_id,
                "alarm_revision": alarm.revision,
                "occurrence_id": occurrence_id_arg,
                "acknowledged_at": acknowledged_at,
                "already_acknowledged": newly_acknowledged == 0,
            });
            record_action_log_tx(tx, &action_id, &action_name, &result, Some(&alarm_id), &now_at)?;
            Ok(result)
        })?;
        Ok(result)
    }

    // ------------------------------------------------------------------
    // Wakeup, claim, completion, release
    // ------------------------------------------------------------------

    /// The earliest due occurrence across enabled current alarms. The premise
    /// is derived durable state — the wakeup never creates Action authority.
    pub fn next_wakeup(&self) -> Result<Option<WakeupPremise>, AlarmError> {
        let now = self.now()?;
        let Some((scheduled_us, occurrence_id, alarm_id)) = self.store.earliest_due()? else {
            return Ok(None);
        };
        Ok(Some(WakeupPremise {
            at_us: scheduled_us.max(now),
            key: format!("{alarm_id}:{occurrence_id}"),
        }))
    }

    /// Claim every currently-due occurrence in scheduled order. Competing
    /// workers converge on exactly one holder per occurrence via compare
    /// and-set with a finite lease.
    pub fn claim_due(&mut self, claimer: &str) -> Result<Vec<Claim>, AlarmError> {
        if claimer.is_empty() {
            return Err(AlarmError::new(
                AlarmErrorCode::InvalidSchedule,
                "claimer identity must be nonempty",
            ));
        }
        let now = self.now()?;
        let lease_expires_us = now
            .checked_add(self.config.lease_seconds as i64 * US_PER_SECOND)
            .ok_or_else(|| AlarmError::new(AlarmErrorCode::ClockUnavailable, "lease overflow"))?;
        let grace_lo = now.saturating_sub(self.config.misfire_grace_seconds as i64 * US_PER_SECOND);
        self.store
            .claim_due(self.fp().as_ref(), now, grace_lo, claimer, lease_expires_us)
    }

    /// Complete a held claim: persist the typed output premise and advance
    /// the occurrence to FIRED, then materialize the next occurrence (schedule
    /// or repeat) in the same transaction.
    pub fn complete(&mut self, claim: &Claim) -> Result<FiredEvent, AlarmError> {
        let now = self.now()?;
        let alarm = self
            .store
            .get_alarm(&claim.alarm_id)?
            .ok_or_else(|| alarm_not_found(&claim.alarm_id))?;
        let now_at = format_utc_iso6(now);
        let repeat_interval = alarm.delivery_shape.repeat_interval_seconds();
        let ack_required = repeat_interval.is_some();
        let event = FiredEvent {
            occurrence_id: claim.occurrence_id.clone(),
            alarm_id: claim.alarm_id.clone(),
            alarm_revision: claim.alarm_revision,
            title: alarm.title.clone(),
            kind: claim.kind,
            repeat_ordinal: claim.repeat_ordinal,
            scheduled_at: claim.scheduled_at.clone(),
            scheduled_us: claim.scheduled_us,
            fired_at: now_at.clone(),
            lateness_us: now.saturating_sub(claim.scheduled_us),
            misfire_status: claim.misfire_basis,
            ack_required,
        };
        let result_json = event.to_json();
        let schedule = self.build_schedule(&alarm)?;
        let alarm_id = alarm.alarm_id.clone();
        let alarm_revision = alarm.revision;
        let enabled = alarm.enabled;
        let deleted = alarm.deleted;
        let horizon = self.config.wakeup_horizon_seconds;
        self.store.effect(
            self.fp().as_ref(),
            FailpointBoundary::BeforeComplete,
            |tx| {
                let lateness = now.saturating_sub(claim.scheduled_us);
                let changed = tx
                    .execute(
                        "UPDATE occurrences SET state = 'fired', fired_at = ?1, lateness_us = ?2,
                        result_kind = ?3, result_json = ?4,
                        claim_token = NULL, claim_holder = NULL, claim_made_at = NULL,
                        lease_expires_us = NULL
                     WHERE occurrence_id = ?5 AND state = 'claimed' AND claim_token = ?6",
                        params![
                            now_at,
                            lateness,
                            "output_event",
                            result_json,
                            claim.occurrence_id,
                            claim.claim_token
                        ],
                    )
                    .map_err(|e| db_unavailable("complete cas", e))?;
                if changed != 1 {
                    return Err(occurrence_not_found(&claim.occurrence_id));
                }
                if !enabled && deleted {
                    return Ok(());
                }
                match claim.kind {
                    OccurrenceKind::Scheduled | OccurrenceKind::Snooze => {
                        if enabled && !deleted {
                            roll_occurrences_tx(
                                tx,
                                &alarm_id,
                                alarm_revision,
                                &schedule,
                                now,
                                &now_at,
                                horizon,
                            )?;
                        }
                    }
                    OccurrenceKind::Repeat => {}
                }
                if let Some(interval) = repeat_interval {
                    if enabled && !deleted {
                        let repeat_source = if claim.kind == OccurrenceKind::Repeat {
                            claim
                                .parent_occurrence_id
                                .as_deref()
                                .unwrap_or(&claim.occurrence_id)
                        } else {
                            &claim.occurrence_id
                        };
                        roll_repeat_tx(
                            tx,
                            &alarm_id,
                            alarm_revision,
                            repeat_source,
                            now,
                            interval,
                            &now_at,
                            horizon,
                        )?;
                    }
                }
                recompute_next_tx(tx, &alarm_id, now, true)?;
                Ok(())
            },
        )?;
        Ok(event)
    }

    /// Release a held claim back to DUE when the host output was not
    /// committed.
    pub fn release(&mut self, claim: &Claim) -> Result<bool, AlarmError> {
        self.store.release_claim(self.fp().as_ref(), claim)
    }

    // ------------------------------------------------------------------
    // Settle / recover
    // ------------------------------------------------------------------

    /// Deterministic recovery pass. `outcome_for_expired` lets the runtime
    /// answer, for each expired claim, whether its Activation output was
    /// committed (Applied), not applied (NotApplied, retry), or Unknown
    /// (leave claimed).
    pub fn settle(
        &mut self,
        outcome_for_expired: &(dyn Fn(&str, &str) -> Outcome + Sync),
    ) -> Result<SettleReport, AlarmError> {
        let now = self.now()?;
        let mut report = SettleReport::default();

        // 1. Reconcile expired claims via compare on the occurrence state.
        let expired = self.store.expired_claims(now)?;
        for expired in expired {
            let outcome = outcome_for_expired(
                &expired.occurrence.occurrence_id,
                &expired.occurrence.alarm_id,
            );
            let occurrence_id = expired.occurrence.occurrence_id.clone();
            match outcome {
                Outcome::Applied => {
                    let claim_made_at = expired
                        .occurrence
                        .claim_made_at
                        .clone()
                        .unwrap_or_else(|| format_utc_iso6(now));
                    let claim_made_us =
                        parse_utc_timestamp_us(&claim_made_at, "claim_made_at").unwrap_or(now);
                    let lateness = claim_made_us.saturating_sub(expired.occurrence.scheduled_us);
                    self.store.effect(self.fp().as_ref(), FailpointBoundary::BeforeReconcile, |tx| {
                        tx.execute(
                            "UPDATE occurrences SET state = 'fired', fired_at = ?1, lateness_us = ?2,
                                result_kind = 'runtime_applied', result_json = '{\"source\":\"reconcile\"}',
                                claim_token = NULL, claim_holder = NULL, claim_made_at = NULL,
                                lease_expires_us = NULL
                             WHERE occurrence_id = ?3 AND state = 'claimed'",
                            params![claim_made_at, lateness, occurrence_id],
                        )
                        .map_err(|e| db_unavailable("reconcile applied", e))?;
                        Ok(())
                    })?;
                    report.reconciled_applied.push(occurrence_id);
                }
                Outcome::NotApplied => {
                    // Retry with the same identity — but never reopen a claim
                    // for a superseded or deleted rule.
                    let eligible = expired
                        .alarm
                        .as_ref()
                        .map(|alarm| {
                            !alarm.deleted
                                && alarm.enabled
                                && alarm.revision == expired.occurrence.alarm_revision
                        })
                        .unwrap_or(false);
                    let (state, reason) = if eligible {
                        (OccurrenceState::Due, None)
                    } else {
                        (OccurrenceState::Suppressed, Some("superseded"))
                    };
                    self.store.effect(
                        self.fp().as_ref(),
                        FailpointBoundary::BeforeReconcile,
                        |tx| {
                            tx.execute(
                                "UPDATE occurrences SET state = ?1, missed_reason = ?2,
                                claim_token = NULL, claim_holder = NULL, claim_made_at = NULL,
                                lease_expires_us = NULL
                             WHERE occurrence_id = ?3 AND state = 'claimed'",
                                params![state.as_str(), reason, occurrence_id],
                            )
                            .map_err(|e| db_unavailable("reconcile reopen", e))?;
                            Ok(())
                        },
                    )?;
                    report.reconciled_reopened.push(occurrence_id);
                }
                Outcome::Unknown => {
                    report.reconciled_unknown.push(occurrence_id);
                }
            }
        }

        // 2. Per-alarm settle: tzdb recompute, misfire partition, roll.
        let alarms = self.store.list_alarms(None)?;
        for alarm in alarms {
            if alarm.deleted || !alarm.enabled {
                continue;
            }
            self.settle_alarm(&alarm, now)?;
            report.alarms_settled += 1;
        }

        // 3. Retention prune of terminal history.
        let older_than_us =
            now.saturating_sub(self.config.retention_seconds as i64 * US_PER_SECOND);
        self.store
            .prune_history(self.fp().as_ref(), older_than_us)?;
        Ok(report)
    }

    /// One alarm's deterministic settle pass: tzdb recomputation first, then
    /// misfire (persisted before the future roll), then the horizon roll and
    /// next_occurrence recompute.
    fn settle_alarm(&mut self, alarm: &AlarmRow, now: UsInstant) -> Result<(), AlarmError> {
        let now_at = format_utc_iso6(now);
        let schedule = self.build_schedule(alarm)?;
        let tzdb_changed = matches!(schedule, Schedule::Cron { .. })
            && alarm.tzdb_revision != self.config.tzdb_revision;
        let rule_revision = alarm.revision;
        let alarm_id = alarm.alarm_id.clone();

        // 1. tzdb upgrade: future (not already-fired) occurrences are
        // recomputed deterministically; the record advances to the new
        // revision.
        if tzdb_changed {
            self.store.effect(self.fp().as_ref(), FailpointBoundary::BeforeReconcile, |tx| {
                tx.execute(
                    "UPDATE occurrences SET state = 'suppressed', missed_reason = 'tzdb_recomputed'
                     WHERE alarm_id = ?1 AND alarm_revision = ?2 AND state = 'due' AND scheduled_us > ?3",
                    params![alarm_id, rule_revision as i64, now],
                )
                .map_err(|e| db_unavailable("tzdb recompute suppress", e))?;
                let fields = AlarmRowUpdate {
                    tzdb_revision: Some(self.config.tzdb_revision.clone()),
                    updated_at: Some(now_at.clone()),
                    ..Default::default()
                };
                update_alarm_fields_tx(tx, &alarm_id, rule_revision, &fields)?;
                Ok(())
            })?;
        }

        // 2. Misfire partition plus horizon roll in one transaction.
        let grace_lo = now.saturating_sub(self.config.misfire_grace_seconds as i64 * US_PER_SECOND);
        let scan_lo = now.saturating_sub(self.config.misfire_scan_seconds as i64 * US_PER_SECOND);
        let max_catch_up = self.config.max_catch_up;
        let policy = alarm.misfire_policy;
        let delivery = alarm.delivery_shape.clone();
        let horizon = self.config.wakeup_horizon_seconds;

        self.store
            .effect(self.fp().as_ref(), FailpointBoundary::BeforeMisfire, |tx| {
                let due = due_occurrences_tx(tx, &alarm_id)?;
                perform_misfire_pass(
                    tx,
                    &alarm_id,
                    rule_revision,
                    &schedule,
                    &due,
                    now,
                    grace_lo,
                    scan_lo,
                    policy,
                    max_catch_up,
                    self.config.misfire_grace_seconds as usize + 4,
                    &now_at,
                )?;
                // Roll future occurrences after the misfire decision is persisted.
                roll_occurrences_tx(
                    tx,
                    &alarm_id,
                    rule_revision,
                    &schedule,
                    now,
                    &now_at,
                    horizon,
                )?;
                roll_all_repeats_tx(
                    tx,
                    &alarm_id,
                    rule_revision,
                    now,
                    &now_at,
                    horizon,
                    &delivery,
                )?;
                recompute_next_tx(tx, &alarm_id, now, true)?;
                Ok(())
            })?;
        Ok(())
    }
}

/// The deterministic misfire partition: within-grace occurrences stay
/// claimable; beyond-grace occurrences are partitioned per policy and the
/// coalesced count of skipped older occurrences is persisted as a bounded
/// diagnostic, before any future occurrence is scheduled.
#[allow(clippy::too_many_arguments)]
fn perform_misfire_pass(
    tx: &rusqlite::Transaction<'_>,
    alarm_id: &str,
    rule_revision: u64,
    schedule: &Schedule,
    due: &[Occurrence],
    now: UsInstant,
    grace_lo: UsInstant,
    scan_lo: UsInstant,
    policy: MisfirePolicy,
    max_catch_up: u64,
    grace_cap: usize,
    now_at: &str,
) -> Result<(), AlarmError> {
    // Materialized past rows (scheduled <= now).
    let past_rows: Vec<&Occurrence> = due.iter().filter(|o| o.scheduled_us <= now).collect();
    if past_rows.is_empty() {
        return Ok(());
    }
    let row_by_instant: HashSet<(UsInstant, u8)> = past_rows
        .iter()
        .map(|o| (o.scheduled_us, o.fold_ordinal))
        .collect();
    let old_rows: Vec<&Occurrence> = past_rows
        .iter()
        .filter(|o| o.scheduled_us <= grace_lo && o.scheduled_us >= scan_lo)
        .copied()
        .collect();
    // 1. Within-grace unmaterialized instants become claimable rows.
    let (within_instants, _) =
        window_occurrences(schedule, grace_lo.saturating_add(1), now, grace_cap)?;
    for instant in &within_instants {
        if row_by_instant.contains(&(instant.scheduled_us, instant.fold_ordinal)) {
            continue;
        }
        insert_occurrence_tx(
            tx,
            &NewOccurrence {
                occurrence_id: occurrence_id(
                    alarm_id,
                    rule_revision,
                    instant.scheduled_us,
                    instant.fold_ordinal,
                ),
                scheduled_us: instant.scheduled_us,
                fold_ordinal: instant.fold_ordinal,
                kind: OccurrenceKind::Scheduled,
                repeat_ordinal: 0,
                parent_occurrence_id: None,
            },
            rule_revision,
            alarm_id,
            &format_utc_iso6(instant.scheduled_us),
            now_at,
        )?;
    }

    // 2. Beyond-grace: newest `keep_limit` instants may still fire; all older
    //    become missed, rounded into the bounded diagnostic.
    let (old_instants, old_total) =
        window_occurrences(schedule, scan_lo, grace_lo, max_catch_up as usize + 4)?;
    let keep_limit = match policy {
        MisfirePolicy::Skip => 0,
        MisfirePolicy::FireOnce => 1,
        MisfirePolicy::CatchUp => max_catch_up as usize,
    };
    // Merge the newest instants: materialized rows plus unmaterialized
    // candidates, newest first.
    let mut merged: Vec<(UsInstant, u8)> = old_rows
        .iter()
        .map(|o| (o.scheduled_us, o.fold_ordinal))
        .collect();
    for instant in &old_instants {
        if !row_by_instant.contains(&(instant.scheduled_us, instant.fold_ordinal)) {
            merged.push((instant.scheduled_us, instant.fold_ordinal));
        }
    }
    merged.sort_by_key(|(us, _)| std::cmp::Reverse(*us));
    merged.dedup_by_key(|(us, _)| *us);
    let keep_count = keep_limit.min(merged.len());
    let keepers: HashSet<(UsInstant, u8)> = merged.iter().take(keep_count).copied().collect();

    // Persist the bound on older rows.
    for row in &old_rows {
        let keep = keepers.contains(&(row.scheduled_us, row.fold_ordinal)) && keep_limit > 0;
        if keep {
            let basis = match policy {
                MisfirePolicy::FireOnce => MisfireBasis::FireOnce,
                _ => MisfireBasis::CatchUp,
            };
            update_occurrence_state_tx(
                tx,
                &row.occurrence_id,
                OccurrenceState::Due,
                None,
                Some(basis),
                None,
            )?;
        } else {
            let reason = match policy {
                MisfirePolicy::Skip => "skip",
                MisfirePolicy::FireOnce => "skip",
                MisfirePolicy::CatchUp => "catch_up_cap",
            };
            update_occurrence_state_tx(
                tx,
                &row.occurrence_id,
                OccurrenceState::Missed,
                Some(reason),
                None,
                None,
            )?;
        }
    }
    // Backfill the kept unmaterialized instants.
    for &(scheduled_us, fold) in merged.iter().take(keep_count) {
        if row_by_instant.contains(&(scheduled_us, fold)) {
            continue;
        }
        let basis = match policy {
            MisfirePolicy::FireOnce => MisfireBasis::FireOnce,
            _ => MisfireBasis::CatchUp,
        };
        insert_occurrence_tx(
            tx,
            &NewOccurrence {
                occurrence_id: occurrence_id(alarm_id, rule_revision, scheduled_us, fold),
                scheduled_us,
                fold_ordinal: fold,
                kind: OccurrenceKind::Scheduled,
                repeat_ordinal: 0,
                parent_occurrence_id: None,
            },
            rule_revision,
            alarm_id,
            &format_utc_iso6(scheduled_us),
            now_at,
        )?;
        update_occurrence_state_tx(
            tx,
            &occurrence_id(alarm_id, rule_revision, scheduled_us, fold),
            OccurrenceState::Due,
            None,
            Some(basis),
            None,
        )?;
    }
    // Bounded diagnostic: the count of older occurrences beyond grace that
    // were not fired.
    let reason_diag = match policy {
        MisfirePolicy::Skip => "skip",
        MisfirePolicy::FireOnce => "fire_once",
        MisfirePolicy::CatchUp => "catch_up_cap",
    };
    let dropped = old_total.saturating_sub(keep_count as u64);
    record_diagnostic_tx(
        tx,
        alarm_id,
        reason_diag,
        scan_lo,
        grace_lo,
        dropped,
        now_at,
    )?;
    Ok(())
}

/// Roll future occurrences of the schedule inside `now..now+horizon`, plus
/// always the exact next occurrence (which may lie beyond the horizon). All
/// inserts are idempotent by canonical identity, bounded by the row cap.
fn roll_occurrences_tx(
    tx: &rusqlite::Transaction<'_>,
    alarm_id: &str,
    rule_revision: u64,
    schedule: &Schedule,
    now: UsInstant,
    now_at: &str,
    horizon_seconds: u64,
) -> Result<(), AlarmError> {
    let horizon_us = now.saturating_add(horizon_seconds as i64 * US_PER_SECOND);
    let (batch, _) =
        window_occurrences(schedule, now.saturating_add(1), horizon_us, ROLL_BATCH_ROWS)?;
    let mut inserted = 0usize;
    for instant in &batch {
        if inserted >= ROLL_BATCH_ROWS {
            break;
        }
        insert_occurrence_tx(
            tx,
            &NewOccurrence {
                occurrence_id: occurrence_id(
                    alarm_id,
                    rule_revision,
                    instant.scheduled_us,
                    instant.fold_ordinal,
                ),
                scheduled_us: instant.scheduled_us,
                fold_ordinal: instant.fold_ordinal,
                kind: OccurrenceKind::Scheduled,
                repeat_ordinal: 0,
                parent_occurrence_id: None,
            },
            rule_revision,
            alarm_id,
            &format_utc_iso6(instant.scheduled_us),
            now_at,
        )?;
        inserted += 1;
    }
    if batch.is_empty() {
        // The exact next may sit beyond the horizon; materialize it anyway so
        // the wakeup cursor is exact.
        if let Some(next) = next_after(schedule, now)? {
            insert_occurrence_tx(
                tx,
                &NewOccurrence {
                    occurrence_id: occurrence_id(
                        alarm_id,
                        rule_revision,
                        next.scheduled_us,
                        next.fold_ordinal,
                    ),
                    scheduled_us: next.scheduled_us,
                    fold_ordinal: next.fold_ordinal,
                    kind: OccurrenceKind::Scheduled,
                    repeat_ordinal: 0,
                    parent_occurrence_id: None,
                },
                rule_revision,
                alarm_id,
                &format_utc_iso6(next.scheduled_us),
                now_at,
            )?;
        }
    }
    Ok(())
}

/// Materialize the next repeat occurrence of an unacknowledged original
/// (`source_occurrence_id`), at fixed elapsed intervals from its first
/// committed firing.
fn roll_repeat_tx(
    tx: &rusqlite::Transaction<'_>,
    alarm_id: &str,
    rule_revision: u64,
    source_occurrence_id: &str,
    now: UsInstant,
    interval_seconds: u64,
    now_at: &str,
    horizon_seconds: u64,
) -> Result<(), AlarmError> {
    let interval_us = i64::try_from(interval_seconds)
        .ok()
        .and_then(|s| s.checked_mul(US_PER_SECOND))
        .ok_or_else(|| {
            AlarmError::new(AlarmErrorCode::RepeatInterval, "repeat interval overflow")
        })?;
    let source = get_occurrence_tx(tx, source_occurrence_id)?
        .ok_or_else(|| occurrence_not_found(source_occurrence_id))?;
    if source.kind != OccurrenceKind::Scheduled || source.ack_state.is_some() {
        return Ok(());
    }
    let suppress_from = source.repeat_suppress_from.unwrap_or(u64::MAX);
    let max_ordinal: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(repeat_ordinal), 0) FROM occurrences
             WHERE parent_occurrence_id = ?1 AND kind = 'repeat'",
            params![source_occurrence_id],
            |r| r.get(0),
        )
        .map_err(|e| db_unavailable("max repeat", e))?;
    let next_ordinal = (max_ordinal.max(0) as u64) + 1;
    if next_ordinal >= suppress_from {
        return Ok(());
    }
    let first_fired_us =
        parse_utc_timestamp_us(source.fired_at.as_deref().unwrap_or(now_at), "fired_at")
            .unwrap_or(now);
    let next_us = first_fired_us
        .checked_add(
            (next_ordinal as i64)
                .checked_mul(interval_us)
                .ok_or_else(|| {
                    AlarmError::new(AlarmErrorCode::RepeatInterval, "repeat instant overflow")
                })?,
        )
        .ok_or_else(|| {
            AlarmError::new(AlarmErrorCode::RepeatInterval, "repeat instant overflow")
        })?;
    let horizon_us = now.saturating_add(horizon_seconds as i64 * US_PER_SECOND);
    if next_us > horizon_us {
        return Ok(());
    }
    insert_occurrence_tx(
        tx,
        &NewOccurrence {
            occurrence_id: repeat_identity(source_occurrence_id, next_ordinal),
            scheduled_us: next_us,
            fold_ordinal: 0,
            kind: OccurrenceKind::Repeat,
            repeat_ordinal: next_ordinal,
            parent_occurrence_id: Some(source_occurrence_id.to_string()),
        },
        rule_revision,
        alarm_id,
        &format_utc_iso6(next_us),
        now_at,
    )?;
    Ok(())
}

/// Materialize the next repeat for every fired, unacknowledged original of an
/// alarm with repeat delivery.
fn roll_all_repeats_tx(
    tx: &rusqlite::Transaction<'_>,
    alarm_id: &str,
    rule_revision: u64,
    now: UsInstant,
    now_at: &str,
    horizon_seconds: u64,
    delivery: &DeliveryShape,
) -> Result<(), AlarmError> {
    let Some(interval) = delivery.repeat_interval_seconds() else {
        return Ok(());
    };
    let mut statement = tx
        .prepare(
            "SELECT * FROM occurrences
             WHERE alarm_id = ?1 AND kind = 'scheduled' AND alarm_revision = ?2 AND state = 'fired'",
        )
        .map_err(|e| db_unavailable("prepare repeat roll", e))?;
    let originals = statement
        .query_map(params![alarm_id, rule_revision as i64], occurrence_from_row)
        .map_err(|e| db_unavailable("repeat roll query", e))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| db_unavailable("repeat roll query", e))?;
    for original in originals {
        roll_repeat_tx(
            tx,
            alarm_id,
            rule_revision,
            &original.occurrence_id,
            now,
            interval,
            now_at,
            horizon_seconds,
        )?;
    }
    Ok(())
}

fn suppress_due_tx(
    tx: &rusqlite::Transaction<'_>,
    alarm_id: &str,
    only_revision: Option<u64>,
    reason: &str,
) -> Result<u64, AlarmError> {
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
}

fn alarm_not_found(alarm_id: &str) -> AlarmError {
    let mut details = serde_json::Map::new();
    details.insert(
        "alarm_id".to_string(),
        serde_json::Value::String(alarm_id.to_string()),
    );
    AlarmError::with_details(
        AlarmErrorCode::OccurrenceNotFound,
        "alarm not found",
        details,
    )
}

fn revision_conflict(alarm_id: &str, expected: u64) -> AlarmError {
    let mut details = serde_json::Map::new();
    details.insert(
        "alarm_id".to_string(),
        serde_json::Value::String(alarm_id.to_string()),
    );
    details.insert(
        "expected_revision".to_string(),
        serde_json::Value::from(expected),
    );
    AlarmError::with_details(
        AlarmErrorCode::RevisionConflict,
        "alarm revision does not match the expected revision",
        details,
    )
}

fn occurrence_not_found(occurrence_id: &str) -> AlarmError {
    let mut details = serde_json::Map::new();
    details.insert(
        "occurrence_id".to_string(),
        serde_json::Value::String(occurrence_id.to_string()),
    );
    AlarmError::with_details(
        AlarmErrorCode::OccurrenceNotFound,
        "occurrence not found in the expected state",
        details,
    )
}

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

#[derive(Clone, Debug)]
struct ListCursor {
    config_revision: String,
    enabled: Option<bool>,
    next: Option<String>,
    alarm_id: String,
}

fn encode_list_cursor(cursor: ListCursor) -> String {
    format!(
        "v1|{}|{}|{}|{}",
        cursor.config_revision,
        match cursor.enabled {
            Some(true) => "true",
            Some(false) => "false",
            None => "null",
        },
        cursor.next.as_deref().unwrap_or(""),
        cursor.alarm_id
    )
}

fn decode_list_cursor(text: Option<&str>) -> Result<Option<ListCursor>, AlarmError> {
    let Some(text) = text else {
        return Ok(None);
    };
    let parts: Vec<&str> = text.split('|').collect();
    if parts.len() != 5 || parts[0] != "v1" {
        return Err(AlarmError::new(
            AlarmErrorCode::InvalidSchedule,
            "list cursor is malformed",
        ));
    }
    let enabled = match parts[2] {
        "true" => Some(true),
        "false" => Some(false),
        "null" => None,
        _ => {
            return Err(AlarmError::new(
                AlarmErrorCode::InvalidSchedule,
                "list cursor is malformed",
            ));
        }
    };
    Ok(Some(ListCursor {
        config_revision: parts[1].to_string(),
        enabled,
        next: if parts[3].is_empty() {
            None
        } else {
            Some(parts[3].to_string())
        },
        alarm_id: parts[4].to_string(),
    }))
}

/// Deterministic UUIDv7-shaped alarm identity derived from the committed
/// action that creates the alarm. The extension owns the creation namespace;
/// the id is stable across replay and restart.
pub fn derive_alarm_id(action_id: &str) -> String {
    let mut seed = [0u8; 16];
    if action_id.len() == 36 {
        let mut nibbles = [0u8; 32];
        let mut ok = true;
        let mut out = 0usize;
        for &byte in action_id.as_bytes() {
            match byte {
                b'-' => continue,
                b'0'..=b'9' if out < 32 => {
                    nibbles[out] = byte - b'0';
                    out += 1;
                }
                b'a'..=b'f' if out < 32 => {
                    nibbles[out] = byte - b'a' + 10;
                    out += 1;
                }
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok && out == 32 {
            for (i, &nibble) in nibbles.iter().enumerate() {
                let byte = seed[i / 2];
                seed[i / 2] = if i % 2 == 0 {
                    nibble << 4
                } else {
                    byte | nibble
                };
            }
        }
    }
    let digest = dolly_canonical_json::Sha256Digest::compute(&seed);
    let raw = digest.as_bytes();
    let mut out = [0u8; 16];
    out.copy_from_slice(&raw[..16]);
    out[6] = (out[6] & 0x0f) | 0x70; // version 7
    out[8] = (out[8] & 0x3f) | 0x80; // RFC variant
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        out[0],
        out[1],
        out[2],
        out[3],
        out[4],
        out[5],
        out[6],
        out[7],
        out[8],
        out[9],
        out[10],
        out[11],
        out[12],
        out[13],
        out[14],
        out[15]
    )
}
