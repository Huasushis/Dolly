//! `cron_v1` schedule parsing and matching.
//!
//! Per the Alarm spec the five fields are `minute hour day_of_month month
//! day_of_week`. Allowed field grammar is `*`, comma lists, numeric ranges,
//! and positive steps; names, `L`, `W`, `#`, seconds, and out-of-range values
//! are rejected. Day of week is `0..6`, Sunday `0`. Matching happens in local
//! civil time; when both day-of-month and day-of-week are restricted a day
//! matches when either field matches (Vixie semantics); when either field is
//! `*` the restricted field must match.

use crate::error::{AlarmError, AlarmErrorCode};
use crate::time::{CivilTime, days_in_month};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CronRange {
    pub from: u32,
    pub to: u32,
    pub step: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronField {
    /// True only when the whole field is exactly `*`.
    pub is_star: bool,
    pub ranges: Vec<CronRange>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronFields {
    pub minute: CronField,
    pub hour: CronField,
    pub day_of_month: CronField,
    pub month: CronField,
    pub day_of_week: CronField,
}

struct FieldSpec {
    label: &'static str,
    min: u32,
    max: u32,
}

const FIELD_SPECS: [FieldSpec; 5] = [
    FieldSpec {
        label: "minute",
        min: 0,
        max: 59,
    },
    FieldSpec {
        label: "hour",
        min: 0,
        max: 23,
    },
    FieldSpec {
        label: "day_of_month",
        min: 1,
        max: 31,
    },
    FieldSpec {
        label: "month",
        min: 1,
        max: 12,
    },
    FieldSpec {
        label: "day_of_week",
        min: 0,
        max: 6,
    },
];

fn schedule_error(message: impl Into<String>, field: &str, value: &str) -> AlarmError {
    let mut details = serde_json::Map::new();
    details.insert(
        "field".to_string(),
        serde_json::Value::String(field.to_string()),
    );
    details.insert(
        "value".to_string(),
        serde_json::Value::String(value.to_string()),
    );
    AlarmError::with_details(AlarmErrorCode::InvalidSchedule, message, details)
}

fn parse_field(
    spec: &str,
    label: &'static str,
    min: u32,
    max: u32,
) -> Result<CronField, AlarmError> {
    if spec.is_empty() {
        return Err(schedule_error(
            format!("cron {label} field is empty"),
            label,
            spec,
        ));
    }
    if !spec
        .bytes()
        .all(|b| matches!(b, b'0'..=b'9' | b'*' | b'/' | b',' | b'-'))
    {
        return Err(schedule_error(
            format!("cron {label} field may only contain numbers, '*', '/', ',' and '-'"),
            label,
            spec,
        ));
    }
    let items: Vec<&str> = spec.split(',').collect();
    let mut ranges: Vec<CronRange> = Vec::new();
    for &item in &items {
        if item == "*" {
            ranges.push(CronRange {
                from: min,
                to: max,
                step: 1,
            });
            continue;
        }
        if let Some(star_step) = item.strip_prefix("*/") {
            let step = parse_step(star_step, label)?;
            ranges.push(CronRange {
                from: min,
                to: max,
                step,
            });
            continue;
        }
        if !item.contains('-') {
            let value = parse_number(item, label, min, max)?;
            ranges.push(CronRange {
                from: value,
                to: value,
                step: 1,
            });
            continue;
        }
        // range [from]-[to](/step)?
        let (bounds, step) = match item.split_once('/') {
            Some((bounds, step)) => (bounds, Some(parse_step(step, label)?)),
            None => (item, None),
        };
        let (from_text, to_text) = bounds.split_once('-').ok_or_else(|| {
            schedule_error(
                format!("cron {label} item is not a valid number, range, or stepped range"),
                label,
                spec,
            )
        })?;
        let from = parse_number(from_text, label, min, max)?;
        let to = parse_number(to_text, label, min, max)?;
        if from > to {
            return Err(schedule_error(
                format!("cron {label} range start exceeds its end"),
                label,
                spec,
            ));
        }
        ranges.push(CronRange {
            from,
            to,
            step: step.unwrap_or(1),
        });
    }
    Ok(CronField {
        is_star: items.len() == 1 && items[0] == "*",
        ranges,
    })
}

fn parse_step(text: &str, label: &'static str) -> Result<u32, AlarmError> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(schedule_error(
            format!("cron {label} step must be a positive integer"),
            label,
            text,
        ));
    }
    let step = text.parse::<u32>().unwrap();
    if step < 1 {
        return Err(schedule_error(
            format!("cron {label} step must be a positive integer"),
            label,
            text,
        ));
    }
    Ok(step)
}

fn parse_number(text: &str, label: &'static str, min: u32, max: u32) -> Result<u32, AlarmError> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(schedule_error(
            format!("cron {label} value must be an integer in [{min}, {max}]"),
            label,
            text,
        ));
    }
    let value = text.parse::<u32>().unwrap();
    if value < min || value > max {
        return Err(schedule_error(
            format!("cron {label} value must be an integer in [{min}, {max}]"),
            label,
            text,
        ));
    }
    Ok(value)
}

/// Parse and fully validate a five-field `cron_v1` expression.
pub fn parse_cron_expression(expression: &str) -> Result<CronFields, AlarmError> {
    if !expression
        .bytes()
        .all(|b| matches!(b, b'0'..=b'9' | b'*' | b'/' | b',' | b'-' | b' '))
    {
        return Err(AlarmError::new(
            AlarmErrorCode::InvalidSchedule,
            "cron_v1 expression may only contain digits, '*', '/', ',', '-', and spaces",
        ));
    }
    let fields: Vec<&str> = expression.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(AlarmError::new(
            AlarmErrorCode::InvalidSchedule,
            "cron_v1 expression must have exactly five fields (minute, hour, day_of_month, month, day_of_week)",
        ));
    }
    Ok(CronFields {
        minute: parse_field(fields[0], "minute", 0, 59)?,
        hour: parse_field(fields[1], "hour", 0, 23)?,
        day_of_month: parse_field(fields[2], "day_of_month", 1, 31)?,
        month: parse_field(fields[3], "month", 1, 12)?,
        day_of_week: parse_field(fields[4], "day_of_week", 0, 6)?,
    })
}

/// True when `value` lies inside one of the field's ranges on its step grid.
pub fn field_matches(field: &CronField, value: u32) -> bool {
    for range in &field.ranges {
        if value >= range.from && value <= range.to && (value - range.from) % range.step == 0 {
            return true;
        }
    }
    false
}

/// Day of week of a civil date, Sunday 0.
pub fn day_of_week(civil: &CivilTime) -> u32 {
    let days = crate::time::days_from_civil(civil.year, civil.month, civil.day);
    // 1970-01-01 was a Thursday (cron weekday 4).
    (4 + days).rem_euclid(7) as u32
}

/// Day match with Vixie DOM/DOW semantics: both restricted => either
/// matches; exactly one restricted => the restricted field must match; both
/// unrestricted => match.
pub fn day_matches(fields: &CronFields, civil: &CivilTime) -> bool {
    let dom_match = field_matches(&fields.day_of_month, civil.day);
    let dow_match = field_matches(&fields.day_of_week, day_of_week(civil));
    let dom_star = fields.day_of_month.is_star;
    let dow_star = fields.day_of_week.is_star;
    match (dom_star, dow_star) {
        (true, true) => true,
        (true, false) => dow_match,
        (false, true) => dom_match,
        (false, false) => dom_match || dow_match,
    }
}

/// Validate that the expression's day-of-month field can ever match in the
/// given month (used to reject obviously dead expressions early; matching
/// itself remains exact).
pub fn month_days(month: u32) -> u32 {
    match month {
        2 => 29,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

pub fn validate_dom_matches_month(fields: &CronFields, month: u32) -> bool {
    let max = days_in_month(2000, month);
    for range in &fields.day_of_month.ranges {
        if range.from <= max && range.to >= 1 {
            return true;
        }
    }
    false
}
/// Whether an expression's month field matches a given month.
pub fn month_matches(fields: &CronFields, month: u32) -> bool {
    field_matches(&fields.month, month)
}
