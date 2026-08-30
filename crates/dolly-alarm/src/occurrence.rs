//! Deterministic occurrence evaluation and identity.
//!
//! Occurrence identity is the canonical `sha256:` digest of the UTF-8 JCS
//! bytes of the spec section 4 tuple
//! `["dolly.alarm.occurrence/v1", alarm_id, alarm_revision,
//! scheduled_utc_instant, fold_ordinal]`, so identities are stable across
//! restart, tzdb revision changes, and competing schedulers. A repeat
//! delivery uses the spec's
//! `["dolly.alarm.repeat/v1", occurrence_id, repeat_ordinal]` tuple. A
//! snooze child occurrence uses
//! `["dolly.alarm.snooze/v1", alarm_id, occurrence_id, alarm_revision,
//! new_at]`, derived from the source occurrence it reschedules.
//!
//! Schedule evaluation is pure for a fixed (rule, tzdb revision, boundary)
//! and has a configured iteration bound, per REQ-ALARM-001.

use crate::cron::{CronFields, day_matches, field_matches, parse_cron_expression};
use crate::error::{AlarmError, AlarmErrorCode};
use crate::time::{
    CivilTime, US_PER_SECOND, UsInstant, days_from_civil, format_utc_iso6, parse_local_date,
    us_to_civil,
};
use crate::tzdb::{FixedZone, ResolvedCivil};
use dolly_canonical_json::canonicalize;

/// One materializable occurrence instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct OccurrenceInstant {
    pub scheduled_us: UsInstant,
    /// 0 for unambiguous or earlier; 1 for the later instant of a fold.
    pub fold_ordinal: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DstGapPolicy {
    /// Add the exact gap duration and fire at the resolved instant.
    ShiftByGap,
    /// Create no occurrence.
    Skip,
}

/// DST fold policy for ambiguous local times.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DstFoldPolicy {
    Earlier,
    Later,
    Both,
}

pub const DEFAULT_ITERATION_BOUND: u32 = 24 * 60;

/// Civil-day search bound for the exact "next occurrence" of a cron
/// schedule. Four years cover every field combination including 29 February.
pub const CRON_SEARCH_BOUND_DAYS: i64 = 1461;

impl DstGapPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            DstGapPolicy::ShiftByGap => "shift_by_gap",
            DstGapPolicy::Skip => "skip",
        }
    }
}

impl DstFoldPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            DstFoldPolicy::Earlier => "earlier",
            DstFoldPolicy::Later => "later",
            DstFoldPolicy::Both => "both",
        }
    }
}

/// A parsed, validated schedule.
#[derive(Debug, Clone)]
pub enum Schedule {
    Once {
        at_us: UsInstant,
    },
    Interval {
        every_us: i64,
        anchor_us: UsInstant,
    },
    Cron {
        expression: String,
        zone: Option<std::sync::Arc<FixedZone>>,
        gap_policy: DstGapPolicy,
        fold_policy: DstFoldPolicy,
    },
}

/// Evaluate one civil day and return its ordered occurrence instants.
///
/// Bound on probes: `24 * 60` (hour × minute), configured.
pub fn evaluate_cron_day(
    expression: &str,
    zone: &FixedZone,
    gap_policy: DstGapPolicy,
    fold_policy: DstFoldPolicy,
    local_date: &str,
    iteration_bound: u32,
) -> Result<Vec<OccurrenceInstant>, AlarmError> {
    let fields = parse_cron_expression(expression)?;
    let (year, month, day) = parse_local_date(local_date)?;
    evaluate_cron_day_fields(
        &fields,
        zone,
        gap_policy,
        fold_policy,
        year,
        month,
        day,
        iteration_bound,
    )
}

fn evaluate_cron_day_fields(
    fields: &CronFields,
    zone: &FixedZone,
    gap_policy: DstGapPolicy,
    fold_policy: DstFoldPolicy,
    year: i32,
    month: u32,
    day: u32,
    iteration_bound: u32,
) -> Result<Vec<OccurrenceInstant>, AlarmError> {
    if !crate::cron::month_matches(fields, month) {
        return Ok(Vec::new());
    }
    let mut occurrences: Vec<OccurrenceInstant> = Vec::new();
    let mut probes: u32 = 0;
    for hour in 0..24u32 {
        if !field_matches(&fields.hour, hour) {
            continue;
        }
        for minute in 0..60u32 {
            if !field_matches(&fields.minute, minute) {
                continue;
            }
            probes += 1;
            if probes > iteration_bound {
                return Err(AlarmError::with_details(
                    AlarmErrorCode::IterationBound,
                    "cron day evaluation exceeded its iteration bound",
                    {
                        let mut d = serde_json::Map::new();
                        d.insert(
                            "bound".to_string(),
                            serde_json::Value::from(iteration_bound),
                        );
                        d
                    },
                ));
            }
            let civil = CivilTime {
                year,
                month,
                day,
                hour,
                minute,
                second: 0,
            };
            if !day_matches(fields, &civil) {
                continue;
            }
            collect_for_civil_time(zone, &civil, gap_policy, fold_policy, &mut occurrences);
        }
    }
    occurrences.sort_by_key(|o| o.scheduled_us);
    Ok(occurrences)
}

fn collect_for_civil_time(
    zone: &FixedZone,
    civil: &CivilTime,
    gap_policy: DstGapPolicy,
    fold_policy: DstFoldPolicy,
    occurrences: &mut Vec<OccurrenceInstant>,
) {
    let resolved: Vec<ResolvedCivil> = zone.resolve_civil(civil);
    if !resolved.is_empty() {
        match fold_policy {
            DstFoldPolicy::Both => {
                for entry in &resolved {
                    occurrences.push(OccurrenceInstant {
                        scheduled_us: entry.us,
                        fold_ordinal: entry.fold_ordinal,
                    });
                }
            }
            DstFoldPolicy::Later => {
                let entry = resolved.last().unwrap();
                occurrences.push(OccurrenceInstant {
                    scheduled_us: entry.us,
                    fold_ordinal: entry.fold_ordinal,
                });
            }
            DstFoldPolicy::Earlier => {
                let entry = &resolved[0];
                occurrences.push(OccurrenceInstant {
                    scheduled_us: entry.us,
                    fold_ordinal: entry.fold_ordinal,
                });
            }
        }
        return;
    }
    if gap_policy == DstGapPolicy::ShiftByGap {
        if let Some(shifted_us) = zone.shift_by_gap_us(civil) {
            occurrences.push(OccurrenceInstant {
                scheduled_us: shifted_us,
                fold_ordinal: 0,
            });
        }
    }
}

fn overflow_error() -> AlarmError {
    AlarmError::new(
        AlarmErrorCode::InvalidSchedule,
        "schedule arithmetic overflow",
    )
}

/// The exact earliest occurrence instant strictly after `now`, or `None`.
pub fn next_after(
    schedule: &Schedule,
    now: UsInstant,
) -> Result<Option<OccurrenceInstant>, AlarmError> {
    match schedule {
        Schedule::Once { at_us } => Ok((*at_us > now).then_some(OccurrenceInstant {
            scheduled_us: *at_us,
            fold_ordinal: 0,
        })),
        Schedule::Interval {
            every_us,
            anchor_us,
        } => {
            if *every_us <= 0 {
                return Err(AlarmError::new(
                    AlarmErrorCode::InvalidSchedule,
                    "interval duration must be positive",
                ));
            }
            if *anchor_us > now {
                return Ok(Some(OccurrenceInstant {
                    scheduled_us: *anchor_us,
                    fold_ordinal: 0,
                }));
            }
            let steps = (now - anchor_us).div_euclid(*every_us) + 1;
            let next_us = anchor_us
                .checked_add(steps.checked_mul(*every_us).ok_or_else(overflow_error)?)
                .ok_or_else(overflow_error)?;
            Ok(Some(OccurrenceInstant {
                scheduled_us: next_us,
                fold_ordinal: 0,
            }))
        }
        Schedule::Cron {
            expression,
            zone: Some(zone),
            gap_policy,
            fold_policy,
        } => {
            let fields = parse_cron_expression(expression)?;
            let start_civil = zone.civil_at(now, 0);
            let start_days = days_from_civil(start_civil.year, start_civil.month, start_civil.day);
            let iteration_bound = DEFAULT_ITERATION_BOUND;
            for offset in 0..=CRON_SEARCH_BOUND_DAYS {
                let (year, month, day) = crate::time::civil_from_days(start_days + offset);
                let occs = evaluate_cron_day_fields(
                    &fields,
                    zone,
                    *gap_policy,
                    *fold_policy,
                    year,
                    month,
                    day,
                    iteration_bound,
                )?;
                for occ in occs {
                    if occ.scheduled_us > now {
                        return Ok(Some(occ));
                    }
                }
            }
            Ok(None)
        }
        Schedule::Cron { .. } => Err(AlarmError::new(
            AlarmErrorCode::NonexistentTimezone,
            "cron schedule has no timezone rules",
        )),
    }
}

/// Occurrence instants in the inclusive window `[lo, hi]`: at most `cap`
/// entries plus the total count. `most_recent == true` keeps the newest
/// entries (misfire keepers); `false` keeps the oldest (the horizon roll must
/// never drop the actual next occurrence). Per-day evaluation is bounded by
/// the cron iteration bound and interval arithmetic is O(1). `cap == 0`
/// retains no instants (count only).
pub fn window_occurrences(
    schedule: &Schedule,
    lo: UsInstant,
    hi: UsInstant,
    cap: usize,
    most_recent: bool,
) -> Result<(Vec<OccurrenceInstant>, u64), AlarmError> {
    if hi < lo {
        return Ok((Vec::new(), 0));
    }
    let mut out: Vec<OccurrenceInstant> = Vec::new();
    let mut total: u64 = 0;
    match schedule {
        Schedule::Once { at_us } => {
            if *at_us >= lo && *at_us <= hi {
                out.push(OccurrenceInstant {
                    scheduled_us: *at_us,
                    fold_ordinal: 0,
                });
                total = 1;
            }
        }
        Schedule::Interval {
            every_us,
            anchor_us,
        } => {
            if *every_us <= 0 {
                return Err(AlarmError::new(
                    AlarmErrorCode::InvalidSchedule,
                    "interval duration must be positive",
                ));
            }
            let first_steps = if *anchor_us >= lo {
                0
            } else {
                (lo - anchor_us + *every_us - 1).div_euclid(*every_us)
            };
            let first_us = anchor_us
                .checked_add(
                    first_steps
                        .checked_mul(*every_us)
                        .ok_or_else(overflow_error)?,
                )
                .ok_or_else(overflow_error)?;
            if first_us > hi {
                return Ok((Vec::new(), 0));
            }
            let last_steps = (hi - anchor_us).div_euclid(*every_us);
            let last_us = anchor_us
                .checked_add(
                    last_steps
                        .checked_mul(*every_us)
                        .ok_or_else(overflow_error)?,
                )
                .ok_or_else(overflow_error)?;
            total = ((last_us - first_us) / *every_us) as u64 + 1;
            let first_kept_steps = if cap == 0 {
                last_steps + 1
            } else {
                last_steps.saturating_sub(cap as i64 - 1).max(first_steps)
            };
            let mut steps = first_kept_steps;
            while steps <= last_steps {
                let us = anchor_us
                    .checked_add(steps.checked_mul(*every_us).ok_or_else(overflow_error)?)
                    .ok_or_else(overflow_error)?;
                out.push(OccurrenceInstant {
                    scheduled_us: us,
                    fold_ordinal: 0,
                });
                steps += 1;
            }
        }
        Schedule::Cron {
            expression,
            zone: Some(zone),
            gap_policy,
            fold_policy,
        } => {
            let fields = parse_cron_expression(expression)?;
            let lo_civil = zone.civil_at(lo, 0);
            let hi_civil = zone.civil_at(hi, 0);
            let lo_days = days_from_civil(lo_civil.year, lo_civil.month, lo_civil.day);
            let hi_days = days_from_civil(hi_civil.year, hi_civil.month, hi_civil.day);
            let max_days = hi_days - lo_days;
            if max_days > CRON_SEARCH_BOUND_DAYS * 4 {
                return Err(AlarmError::with_details(
                    AlarmErrorCode::IterationBound,
                    "occurrence window scan exceeds its bound",
                    {
                        let mut d = serde_json::Map::new();
                        d.insert("days".to_string(), serde_json::Value::from(max_days));
                        d
                    },
                ));
            }
            let iteration_bound = DEFAULT_ITERATION_BOUND;
            for offset in 0..=max_days {
                let (year, month, day) = crate::time::civil_from_days(lo_days + offset);
                let occs = evaluate_cron_day_fields(
                    &fields,
                    zone,
                    *gap_policy,
                    *fold_policy,
                    year,
                    month,
                    day,
                    iteration_bound,
                )?;
                for occ in occs {
                    if occ.scheduled_us >= lo && occ.scheduled_us <= hi {
                        out.push(occ);
                    }
                }
            }
            total = out.len() as u64;
        }
        Schedule::Cron { .. } => {
            return Err(AlarmError::new(
                AlarmErrorCode::NonexistentTimezone,
                "cron schedule has no timezone rules",
            ));
        }
    }
    out.sort_by_key(|o| o.scheduled_us);
    if out.len() > cap {
        let keep = out.len() - cap;
        if most_recent {
            out.drain(..keep);
        } else {
            out.truncate(cap);
        }
    }
    Ok((out, total))
}

/// Whether a materialized instant still belongs to the schedule's occurrence
/// set (used when a tzdb revision change forces recomputation): the instant's
/// civil time under its recorded fold offset must evaluate to that exact
/// instant again.
pub fn instant_still_in_schedule(
    schedule: &Schedule,
    zone: &FixedZone,
    instant: OccurrenceInstant,
) -> Result<bool, AlarmError> {
    let Schedule::Cron {
        expression,
        gap_policy,
        fold_policy,
        ..
    } = schedule
    else {
        return Ok(true);
    };
    let fields = parse_cron_expression(expression)?;
    // The civil time shown in the zone at that instant; the offset that
    // produced it depends on the fold ordinal.
    let offset = zone.offset_minutes_at(instant.scheduled_us);
    let civil = us_to_civil(instant.scheduled_us + offset as i64 * 60 * US_PER_SECOND);
    let occs = evaluate_cron_day_fields(
        &fields,
        zone,
        *gap_policy,
        *fold_policy,
        civil.year,
        civil.month,
        civil.day,
        DEFAULT_ITERATION_BOUND,
    )?;
    Ok(occs
        .iter()
        .any(|o| o.scheduled_us == instant.scheduled_us && o.fold_ordinal == instant.fold_ordinal))
}

/// Canonical occurrence identity (`sha256:` digest of the section 4 tuple).
pub fn occurrence_id(
    alarm_id: &str,
    alarm_revision: u64,
    scheduled_us: UsInstant,
    fold_ordinal: u8,
) -> String {
    identity_digest(&(
        "dolly.alarm.occurrence/v1",
        alarm_id,
        alarm_revision,
        format_utc_iso6(scheduled_us),
        u64::from(fold_ordinal),
    ))
}

/// Canonical repeat-delivery identity for repeat ordinal `n` of an
/// occurrence.
pub fn repeat_identity(occurrence_id_str: &str, repeat_ordinal: u64) -> String {
    identity_digest(&("dolly.alarm.repeat/v1", occurrence_id_str, repeat_ordinal))
}

/// Canonical snooze-child identity derived from the source occurrence.
pub fn snooze_identity(
    alarm_id: &str,
    source_occurrence_id: &str,
    alarm_revision: u64,
    new_at_us: UsInstant,
) -> String {
    identity_digest(&(
        "dolly.alarm.snooze/v1",
        alarm_id,
        source_occurrence_id,
        alarm_revision,
        format_utc_iso6(new_at_us),
    ))
}

fn identity_digest<T: serde::Serialize>(tuple: &T) -> String {
    let (_, digest) =
        canonicalize(tuple).expect("occurrence identity tuples are trivially canonicalizable");
    digest.to_canonical_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn occurrence_id_is_stable_and_distinct() {
        let a = occurrence_id("alarm-1", 4, 1_752_072_800_000_000, 0);
        let b = occurrence_id("alarm-1", 4, 1_752_072_800_000_000, 0);
        let c = occurrence_id("alarm-1", 4, 1_752_072_800_000_000, 1);
        let d = occurrence_id("alarm-1", 5, 1_752_072_800_000_000, 0);
        assert_eq!(a, b);
        assert!(a.starts_with("sha256:"));
        assert_eq!(a.len(), 7 + 64);
        assert_ne!(a, c);
        assert_ne!(a, d);
    }
}
