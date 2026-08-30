//! Time and civil-calendar helpers for the alarm domain.
//!
//! All stored instants are UTC (Core six-digit `YYYY-MM-DDTHH:MM:SS.uuuuuuZ`
//! form). Civil times are only ever a calendar-interpretation input; they
//! carry no offset of their own. Every function is deterministic and pure,
//! with no host-locale dependence: calendars, dates, and offsets are computed
//! explicitly, never via the ambient system timezone or wall clock.

use crate::error::{AlarmError, AlarmErrorCode};

/// Microseconds since the Unix epoch, UTC. Ephemeral arithmetic stays inside
/// `i64`; every input is bounded by the alarm schema (years 1..=9999, repeat
/// interval at most one year).
pub type UsInstant = i64;

pub const US_PER_SECOND: i64 = 1_000_000;
pub const US_PER_MINUTE: i64 = 60 * US_PER_SECOND;

/// A civil calendar interpretation: no timezone, no offset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CivilTime {
    pub year: i32,
    /// 1..=12
    pub month: u32,
    /// 1..=31 (validated for the month)
    pub day: u32,
    /// 0..=23
    pub hour: u32,
    /// 0..=59
    pub minute: u32,
    /// 0..=59
    pub second: u32,
}

/// Days in the proleptic Gregorian month, leap-year aware.
pub fn days_in_month(year: i32, month: u32) -> u32 {
    if month == 2 {
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        if leap {
            return 29;
        }
        return 28;
    }
    match month {
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn invalid_schedule(field: &str, value: impl std::fmt::Display) -> AlarmError {
    let mut details = serde_json::Map::new();
    details.insert(
        "field".to_string(),
        serde_json::Value::String(field.to_string()),
    );
    details.insert(
        "value".to_string(),
        serde_json::Value::String(value.to_string()),
    );
    AlarmError::with_details(
        AlarmErrorCode::InvalidSchedule,
        format!("{field} is out of range"),
        details,
    )
}

/// Validate year/month/day and the field bounds of a `CivilTime`.
pub fn assert_civil(civil: &CivilTime) -> Result<(), AlarmError> {
    if !(1..=9999).contains(&civil.year) {
        return Err(invalid_schedule("year", civil.year));
    }
    if !(1..=12).contains(&civil.month) {
        return Err(invalid_schedule("month", civil.month));
    }
    if civil.day < 1 || civil.day > days_in_month(civil.year, civil.month) {
        return Err(AlarmError::with_details(
            AlarmErrorCode::InvalidSchedule,
            format!("day {}/{} does not exist", civil.month, civil.day),
            {
                let mut d = serde_json::Map::new();
                d.insert(
                    "field".to_string(),
                    serde_json::Value::String("day".to_string()),
                );
                d
            },
        ));
    }
    if civil.hour > 23 || civil.minute > 59 || civil.second > 59 {
        return Err(invalid_schedule(
            "time",
            format!("{:02}:{:02}:{:02}", civil.hour, civil.minute, civil.second),
        ));
    }
    Ok(())
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
pub fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year } as i64;
    let era = y.div_euclid(400);
    let yoe = y - era * 400; // [0, 399]
    let mp = (month as i64) + if month > 2 { -3 } else { 9 }; // [0, 11]
    let doy = (153 * mp + 2) / 5 + day as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// Civil date for a day count since 1970-01-01 (Hinnant's inverse).
pub fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year as i32, m as u32, d as u32)
}

/// Civil time interpreted as microseconds since the epoch, as if UTC.
pub fn civil_to_us(civil: &CivilTime) -> UsInstant {
    let days = days_from_civil(civil.year, civil.month, civil.day);
    days * 86_400 * US_PER_SECOND
        + civil.hour as i64 * 3600 * US_PER_SECOND
        + civil.minute as i64 * 60 * US_PER_SECOND
        + civil.second as i64 * US_PER_SECOND
}

/// UTC microseconds split into civil time, dropping the sub-second fraction.
pub fn us_to_civil(us: UsInstant) -> CivilTime {
    let whole_seconds = us.div_euclid(US_PER_SECOND);
    let days = whole_seconds.div_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let rem = whole_seconds.rem_euclid(86_400);
    CivilTime {
        year,
        month,
        day,
        hour: (rem / 3600) as u32,
        minute: ((rem % 3600) / 60) as u32,
        second: (rem % 60) as u32,
    }
}

fn pad(value: i32, width: usize) -> String {
    format!("{value:0width$}")
}

/// Canonical Core UTC instant: `YYYY-MM-DDTHH:MM:SS.uuuuuuZ`.
pub fn format_utc_iso6(us: UsInstant) -> String {
    let whole_seconds = us.div_euclid(US_PER_SECOND);
    let microseconds = us.rem_euclid(US_PER_SECOND);
    let civil = us_to_civil(whole_seconds * US_PER_SECOND);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:06}Z",
        civil.year, civil.month, civil.day, civil.hour, civil.minute, civil.second, microseconds
    )
}

/// Canonical `YYYY-MM-DD` for a civil date.
pub fn format_date_only(year: i32, month: u32, day: u32) -> String {
    format!("{:04}-{:02}-{:02}", year, month, day)
}

fn parse_zero_padded(text: &str, len: usize, label: &str) -> Result<i64, AlarmError> {
    if text.len() != len || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AlarmError::new(
            AlarmErrorCode::InvalidSchedule,
            format!("{label} must be {len} digits"),
        ));
    }
    Ok(text.parse::<i64>().unwrap())
}

/// Parse an RFC3339 timestamp that carries an explicit `Z` or numeric offset.
///
/// Per the Alarm spec, input without an offset, a leap second, or an invalid
/// calendar date is rejected rather than interpreted with a default zone.
pub fn parse_utc_timestamp_us(text: &str, label: &str) -> Result<UsInstant, AlarmError> {
    let bytes = text.as_bytes();
    // YYYY-MM-DDTHH:MM:SS(.ffffff)?(Z|+hh:mm|-hh:mm)
    if bytes.len() < 20 {
        return Err(rfc_error(label, text));
    }
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return Err(rfc_error(label, text));
    }
    let year = parse_zero_padded(&text[0..4], 4, "year")?;
    let month = parse_zero_padded(&text[5..7], 2, "month")?;
    let day = parse_zero_padded(&text[8..10], 2, "day")?;
    let hour = parse_zero_padded(&text[11..13], 2, "hour")?;
    let minute = parse_zero_padded(&text[14..16], 2, "minute")?;
    let second = parse_zero_padded(&text[17..19], 2, "second")?;

    let mut cursor = 19;
    let mut microseconds: i64 = 0;
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() && cursor - start < 6 {
            cursor += 1;
        }
        let fraction = &text[start..cursor];
        if fraction.is_empty() {
            return Err(rfc_error(label, text));
        }
        let mut fraction = fraction.to_string();
        while fraction.len() < 6 {
            fraction.push('0');
        }
        microseconds = fraction.parse::<i64>().unwrap();
    }

    let zone = bytes
        .get(cursor)
        .copied()
        .ok_or_else(|| rfc_error(label, text))?;
    cursor += 1;
    let mut offset_us: i64 = 0;
    match zone {
        b'Z' | b'z' => {}
        b'+' | b'-' => {
            if bytes.len() - cursor != 5 || bytes[cursor + 2] != b':' {
                return Err(rfc_error(label, text));
            }
            let zone_hour = parse_zero_padded(&text[cursor..cursor + 2], 2, "offset hour")?;
            let zone_minute = parse_zero_padded(&text[cursor + 3..cursor + 5], 2, "offset minute")?;
            if zone_hour > 23 || zone_minute > 59 {
                return Err(AlarmError::new(
                    AlarmErrorCode::InvalidSchedule,
                    format!("{label} offset is out of range"),
                ));
            }
            let magnitude = (zone_hour * 3600 + zone_minute * 60) * US_PER_SECOND;
            offset_us = if zone == b'-' { -magnitude } else { magnitude };
        }
        _ => return Err(rfc_error(label, text)),
    }

    if second == 60 {
        return Err(AlarmError::new(
            AlarmErrorCode::InvalidSchedule,
            format!("{label} must not contain a leap second"),
        ));
    }

    let civil = CivilTime {
        year: year as i32,
        month: month as u32,
        day: day as u32,
        hour: hour as u32,
        minute: minute as u32,
        second: second as u32,
    };
    assert_civil(&civil)?;
    Ok(civil_to_us(&civil) + microseconds - offset_us)
}

fn rfc_error(label: &str, value: &str) -> AlarmError {
    AlarmError::new(
        AlarmErrorCode::InvalidSchedule,
        format!("{label} must be an RFC3339 timestamp with an explicit Z or numeric offset"),
    )
}

/// Parse a `YYYY-MM-DD` calendar date component without applying a timezone.
pub fn parse_local_date(text: &str) -> Result<(i32, u32, u32), AlarmError> {
    if text.len() != 10 || text.as_bytes()[4] != b'-' || text.as_bytes()[7] != b'-' {
        return Err(AlarmError::new(
            AlarmErrorCode::InvalidSchedule,
            "local date must be YYYY-MM-DD",
        ));
    }
    let year = parse_zero_padded(&text[0..4], 4, "year")? as i32;
    let month = parse_zero_padded(&text[5..7], 2, "month")? as u32;
    let day = parse_zero_padded(&text[8..10], 2, "day")? as u32;
    if !(1..=9999).contains(&year) {
        return Err(invalid_schedule("year", year));
    }
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return Err(AlarmError::with_details(
            AlarmErrorCode::InvalidSchedule,
            format!("date {text} does not exist"),
            {
                let mut d = serde_json::Map::new();
                d.insert(
                    "field".to_string(),
                    serde_json::Value::String("date".to_string()),
                );
                d
            },
        ));
    }
    Ok((year, month, day))
}

pub fn pad_time(value: u32) -> String {
    format!("{value:02}")
}
