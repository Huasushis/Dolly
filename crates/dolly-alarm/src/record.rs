//! Durable alarm record model and raw-create normalization.
//!
//! `AlarmRecord` mirrors `schemas/alarm-record.schema.json` exactly
//! (`additionalProperties: false`, all normalized policies materialized).
//! Raw create/update arguments omit a policy to select the default from the
//! operation's frozen config revision; the normalizer materializes every
//! selected policy, timezone, and tzdb revision into the durable record so a
//! persisted record never inherits a later default.
//!
//! The built-in v1 package Extension ID is `org.dolly.alarm`; every stable
//! Alarm Action and every durable record is owned by that exact authority.

use crate::error::{AlarmError, AlarmErrorCode};
use crate::occurrence::{DstFoldPolicy, DstGapPolicy, Schedule};
use crate::time::{UsInstant, format_utc_iso6, parse_utc_timestamp_us};
use crate::tzdb::{ZoneRulesProvider, zone_rules_id};
use serde::{Deserialize, Serialize};

pub const ALARM_EXTENSION_ID: &str = "org.dolly.alarm";

pub const ALARM_CREATE_ACTION: &str = "org.dolly.alarm.create";
pub const ALARM_LIST_ACTION: &str = "org.dolly.alarm.list";
pub const ALARM_GET_ACTION: &str = "org.dolly.alarm.get";
pub const ALARM_UPDATE_ACTION: &str = "org.dolly.alarm.update";
pub const ALARM_DELETE_ACTION: &str = "org.dolly.alarm.delete";
pub const ALARM_SNOOZE_ACTION: &str = "org.dolly.alarm.snooze";
pub const ALARM_ACKNOWLEDGE_ACTION: &str = "org.dolly.alarm.acknowledge";

pub const TITLE_MAX_LENGTH: usize = 256;
pub const REPEAT_MIN_SECONDS: u64 = 1;
pub const REPEAT_MAX_SECONDS: u64 = 31_557_600; // one year
pub const INTERVAL_MAX_SECONDS: u64 = 31_557_600;
const UUIDV7_CHARS: &[u8] = b"0123456789abcdef";

/// Misfire policy: what to do with occurrences that are past their grace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MisfirePolicy {
    /// Older occurrences become missed and emit no reminder.
    Skip,
    /// The most recent older occurrence fires immediately; older become missed.
    FireOnce,
    /// Older occurrences fire in scheduled order up to `max_catch_up`.
    CatchUp,
}

impl MisfirePolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            MisfirePolicy::Skip => "skip",
            MisfirePolicy::FireOnce => "fire_once",
            MisfirePolicy::CatchUp => "catch_up",
        }
    }
}

/// Durable schedule shape, tagged by `kind` per the record schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ScheduleShape {
    #[serde(rename = "once")]
    Once { at: String },
    #[serde(rename = "interval")]
    Interval { every_seconds: u64, anchor: String },
    #[serde(rename = "cron_v1")]
    CronV1 {
        expression: String,
        timezone: String,
    },
}

impl ScheduleShape {
    pub fn kind_name(&self) -> &'static str {
        match self {
            ScheduleShape::Once { .. } => "once",
            ScheduleShape::Interval { .. } => "interval",
            ScheduleShape::CronV1 { .. } => "cron_v1",
        }
    }
}

/// Durable delivery shape, tagged by `mode` per the record schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", deny_unknown_fields)]
pub enum DeliveryShape {
    #[serde(rename = "once")]
    Once,
    #[serde(rename = "repeat_until_acknowledged")]
    RepeatUntilAcknowledged { repeat_interval_seconds: u64 },
}

impl DeliveryShape {
    pub fn repeat_interval_seconds(&self) -> Option<u64> {
        match self {
            DeliveryShape::RepeatUntilAcknowledged {
                repeat_interval_seconds,
            } => Some(*repeat_interval_seconds),
            DeliveryShape::Once => None,
        }
    }
}

/// The fully materialized durable alarm record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AlarmRecord {
    pub alarm_id: String,
    pub revision: u64,
    pub title: String,
    pub schedule: ScheduleShape,
    pub delivery: DeliveryShape,
    pub misfire_policy: MisfirePolicy,
    pub dst_gap_policy: DstGapPolicy,
    pub dst_fold_policy: DstFoldPolicy,
    pub enabled: bool,
    pub created_at: String,
    pub next_occurrence: Option<String>,
    pub tzdb_revision: String,
}

/// Raw create/update schedule input: timezone is optional on `cron_v1` and is
/// normalized from the frozen default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum RawSchedule {
    #[serde(rename = "once")]
    Once { at: String },
    #[serde(rename = "interval")]
    Interval { every_seconds: u64, anchor: String },
    #[serde(rename = "cron_v1")]
    CronV1 {
        expression: String,
        timezone: Option<String>,
    },
}

/// Raw delivery input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", deny_unknown_fields)]
pub enum RawDelivery {
    #[serde(rename = "once")]
    Once,
    #[serde(rename = "repeat_until_acknowledged")]
    RepeatUntilAcknowledged { repeat_interval_seconds: u64 },
}

/// The frozen extension config revision an operation's defaults come from.
#[derive(Debug, Clone)]
pub struct FrozenAlarmConfig {
    /// Immutable identity of this frozen config revision.
    pub revision: String,
    /// The Alarm extension authority; must be `org.dolly.alarm`.
    pub authority: String,
    pub default_timezone: String,
    pub default_misfire_policy: MisfirePolicy,
    pub default_dst_gap_policy: DstGapPolicy,
    pub default_dst_fold_policy: DstFoldPolicy,
    pub tzdb_revision: String,
    pub max_alarms: u64,
    pub max_catch_up: u64,
    pub min_repeat_interval_seconds: u64,
    pub wakeup_horizon_seconds: u64,
    pub misfire_grace_seconds: u64,
    /// Window behind `now` whose older occurrences are counted for misfire.
    pub misfire_scan_seconds: u64,
    pub retention_seconds: u64,
    pub lease_seconds: u64,
}

impl Default for FrozenAlarmConfig {
    fn default() -> Self {
        Self {
            revision: "config-v1".to_string(),
            authority: ALARM_EXTENSION_ID.to_string(),
            default_timezone: "America/New_York".to_string(),
            default_misfire_policy: MisfirePolicy::FireOnce,
            default_dst_gap_policy: DstGapPolicy::ShiftByGap,
            default_dst_fold_policy: DstFoldPolicy::Earlier,
            tzdb_revision: "2025a".to_string(),
            max_alarms: 1000,
            max_catch_up: 10,
            min_repeat_interval_seconds: 1,
            wakeup_horizon_seconds: 7 * 86_400,
            misfire_grace_seconds: 60,
            misfire_scan_seconds: 30 * 86_400,
            retention_seconds: 90 * 86_400,
            lease_seconds: 300,
        }
    }
}

fn require_uuid_v7(value: &str, label: &str) -> Result<(), AlarmError> {
    if value.len() != 36 {
        return Err(uuid_error(label, value));
    }
    let b = value.as_bytes();
    for (index, &byte) in b.iter().enumerate() {
        let ok = match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => (b'0'..=b'9').contains(&byte) || (b'a'..=b'f').contains(&byte),
            19 => (b'8'..=b'9').contains(&byte) || (b'a'..=b'b').contains(&byte),
            0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 9 | 10 | 11 | 12 | 15 | 16 | 17 | 20 | 21 | 22 | 24
            | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 => UUIDV7_CHARS.contains(&byte),
            _ => false,
        };
        if !ok {
            return Err(uuid_error(label, value));
        }
    }
    Ok(())
}

fn uuid_error(label: &str, value: &str) -> AlarmError {
    let mut details = serde_json::Map::new();
    details.insert(
        "field".to_string(),
        serde_json::Value::String(label.to_string()),
    );
    details.insert(
        "value".to_string(),
        serde_json::Value::String(value.to_string()),
    );
    AlarmError::with_details(
        AlarmErrorCode::InvalidSchedule,
        format!("{label} must be a UUIDv7"),
        details,
    )
}

fn require_range(
    value: u64,
    min: u64,
    max: u64,
    label: &str,
    code: AlarmErrorCode,
) -> Result<u64, AlarmError> {
    if value < min || value > max {
        let mut details = serde_json::Map::new();
        details.insert(
            "field".to_string(),
            serde_json::Value::String(label.to_string()),
        );
        details.insert("value".to_string(), serde_json::Value::from(value));
        return Err(AlarmError::with_details(
            code,
            format!("{label} must be an integer in [{min}, {max}]"),
            details,
        ));
    }
    Ok(value)
}

/// Validate a normalized delivery shape against the frozen config.
pub fn validate_delivery(
    delivery: &RawDelivery,
    config: &FrozenAlarmConfig,
) -> Result<(), AlarmError> {
    if let RawDelivery::RepeatUntilAcknowledged {
        repeat_interval_seconds,
    } = delivery
    {
        require_range(
            *repeat_interval_seconds,
            config.min_repeat_interval_seconds.max(REPEAT_MIN_SECONDS),
            REPEAT_MAX_SECONDS,
            "repeat_interval_seconds",
            AlarmErrorCode::RepeatInterval,
        )?;
    }
    Ok(())
}

/// Materialize a raw schedule into its durable shape plus the parsed
/// `Schedule` for occurrence computation.
pub fn normalize_schedule(
    schedule: &RawSchedule,
    config: &FrozenAlarmConfig,
    zones: &dyn ZoneRulesProvider,
) -> Result<(ScheduleShape, Schedule), AlarmError> {
    match schedule {
        RawSchedule::Once { at } => {
            let at_us = parse_utc_timestamp_us(at, "schedule.at")?;
            Ok((
                ScheduleShape::Once {
                    at: format_utc_iso6(at_us),
                },
                Schedule::Once { at_us },
            ))
        }
        RawSchedule::Interval {
            every_seconds,
            anchor,
        } => {
            require_range(
                *every_seconds,
                1,
                INTERVAL_MAX_SECONDS,
                "schedule.every_seconds",
                AlarmErrorCode::InvalidSchedule,
            )?;
            let anchor_us = parse_utc_timestamp_us(anchor, "schedule.anchor")?;
            let every_us = i64::try_from(*every_seconds)
                .ok()
                .and_then(|s| s.checked_mul(1_000_000))
                .ok_or_else(|| {
                    AlarmError::new(
                        AlarmErrorCode::InvalidSchedule,
                        "interval duration overflow",
                    )
                })?;
            Ok((
                ScheduleShape::Interval {
                    every_seconds: *every_seconds,
                    anchor: format_utc_iso6(anchor_us),
                },
                Schedule::Interval {
                    every_us,
                    anchor_us,
                },
            ))
        }
        RawSchedule::CronV1 {
            expression,
            timezone,
        } => {
            crate::cron::parse_cron_expression(expression)?;
            let timezone = timezone
                .clone()
                .unwrap_or_else(|| config.default_timezone.clone());
            let zone_id = zone_rules_id(&timezone, &config.tzdb_revision);
            let zone = zones.zone(&zone_id)?;
            let shape = ScheduleShape::CronV1 {
                expression: expression.clone(),
                timezone,
            };
            let schedule = Schedule::Cron {
                expression: expression.clone(),
                zone: Some(zone),
                gap_policy: config.default_dst_gap_policy,
                fold_policy: config.default_dst_fold_policy,
            };
            Ok((shape, schedule))
        }
    }
}

/// Normalize a raw delivery into its durable shape.
pub fn normalize_delivery(
    delivery: &RawDelivery,
    config: &FrozenAlarmConfig,
) -> Result<DeliveryShape, AlarmError> {
    validate_delivery(delivery, config)?;
    Ok(match delivery {
        RawDelivery::Once => DeliveryShape::Once,
        RawDelivery::RepeatUntilAcknowledged {
            repeat_interval_seconds,
        } => DeliveryShape::RepeatUntilAcknowledged {
            repeat_interval_seconds: *repeat_interval_seconds,
        },
    })
}

pub fn validate_title(title: &str) -> Result<(), AlarmError> {
    if title.is_empty() || title.len() > TITLE_MAX_LENGTH {
        return Err(AlarmError::new(
            AlarmErrorCode::InvalidSchedule,
            "title must be a nonempty string of at most 256 characters",
        ));
    }
    Ok(())
}

pub fn validate_alarm_id(alarm_id: &str) -> Result<(), AlarmError> {
    require_uuid_v7(alarm_id, "alarm_id")
}

pub fn validate_action_id(action_id: &str) -> Result<(), AlarmError> {
    require_uuid_v7(action_id, "action_id")
}

/// Deterministic list ordering: ascending by next_occurrence, JSON `null`
/// after every timestamp, bytewise `alarm_id` tie-break.
pub fn compare_records_for_list(a: &AlarmRecord, b: &AlarmRecord) -> std::cmp::Ordering {
    match (a.next_occurrence.as_deref(), b.next_occurrence.as_deref()) {
        (Some(x), Some(y)) => x.cmp(y).then_with(|| a.alarm_id.cmp(&b.alarm_id)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.alarm_id.cmp(&b.alarm_id),
    }
}

/// Canonical UTC form of an instant.
pub fn utc_iso6(us: UsInstant) -> String {
    format_utc_iso6(us)
}
