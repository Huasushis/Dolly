//! Injected clock for deterministic Channel behavior.
//!
//! The Channel never reads the system clock directly; every ordering,
//! staleness, timeout, and rate-limit decision is driven by the injected
//! [`Clock`] so tests are fully deterministic. Time is represented as integer
//! microseconds since the Unix epoch so all arithmetic is exact.

use dolly_core_domain::Timestamp;
use std::str::FromStr;

/// A source of the current UTC timestamp.
pub trait Clock {
    fn now(&self) -> Timestamp;
}

/// Total microseconds since 1970-01-01T00:00:00Z for one
/// `YYYY-MM-DDTHH:MM:SS.ffffffZ` timestamp. Values stay within the proleptic
/// Gregorian calendar (year range within `i64` micros).
pub fn timestamp_total_micros(s: &str) -> i64 {
    let year = parse_ascii(&s[0..4]);
    let month = parse_ascii(&s[5..7]);
    let day = parse_ascii(&s[8..10]);
    let hour = parse_ascii(&s[11..13]);
    let minute = parse_ascii(&s[14..16]);
    let second = parse_ascii(&s[17..19]);
    let fraction: i64 = s[20..26].parse().unwrap();

    let days = days_from_civil(year as i64, month as i64, day as i64);
    (days * 86_400 + hour as i64 * 3_600 + minute as i64 * 60 + second as i64) * 1_000_000
        + fraction
}

/// Convert total microseconds since the epoch back into a timestamp string.
pub fn timestamp_from_total_micros(total: i64) -> String {
    let mut micros = total % 1_000_000;
    let mut secs = total / 1_000_000;
    if micros < 0 {
        micros += 1_000_000;
        secs -= 1;
    }
    let day_seconds = secs % 86_400;
    let day_offset = secs / 86_400;
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    let (year, month, day) = civil_from_days(day_offset);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:06}Z",
        year, month, day, hour, minute, second, micros
    )
}

/// Add a signed seconds offset to a timestamp string.
pub fn timestamp_plus_seconds(s: &str, offset_seconds: i64) -> String {
    timestamp_from_total_micros(timestamp_total_micros(s) + offset_seconds * 1_000_000)
}

/// Difference in microseconds between two timestamp strings (`right - left`).
pub fn timestamp_diff_micros(left: &str, right: &str) -> i64 {
    timestamp_total_micros(right) - timestamp_total_micros(left)
}

fn parse_ascii(s: &str) -> u64 {
    let mut v: u64 = 0;
    for b in s.bytes() {
        v = v * 10 + (b - b'0') as u64;
    }
    v
}

/// Days since 1970-01-01 from a civil date (Howard Hinnant algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Civil date from days since 1970-01-01 (Howard Hinnant algorithm).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// A mutable clock whose value is set and advanced by the caller.
#[derive(Debug, Clone)]
pub struct VirtualClock {
    now: Timestamp,
}

impl VirtualClock {
    pub fn at(now: Timestamp) -> Self {
        Self { now }
    }

    pub fn set(&mut self, now: Timestamp) {
        self.now = now;
    }

    pub fn advance_seconds(&mut self, seconds: i64) {
        let next = timestamp_plus_seconds(self.now.as_str(), seconds);
        self.now = Timestamp::from_str(&next).expect("computed timestamp is valid");
    }

    pub fn advance_micros(&mut self, micros: i64) {
        let next = timestamp_from_total_micros(timestamp_total_micros(self.now.as_str()) + micros);
        self.now = Timestamp::from_str(&next).expect("computed timestamp is valid");
    }

    pub fn now(&self) -> Timestamp {
        self.now.clone()
    }
}

impl Clock for VirtualClock {
    fn now(&self) -> Timestamp {
        self.now.clone()
    }
}

/// A fixed (never advancing) clock, useful for freeze tests.
#[derive(Debug, Clone)]
pub struct FixedClock {
    now: Timestamp,
}

impl FixedClock {
    pub fn at(now: Timestamp) -> Self {
        Self { now }
    }
}

impl Clock for FixedClock {
    fn now(&self) -> Timestamp {
        self.now.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(s: &str) -> Timestamp {
        Timestamp::from_str(s).unwrap()
    }

    #[test]
    fn virtual_clock_advances_deterministically() {
        let mut clock = VirtualClock::at(ts("2026-08-09T15:00:00.000000Z"));
        clock.advance_seconds(90);
        assert_eq!(clock.now().as_str(), "2026-08-09T15:01:30.000000Z");
    }

    #[test]
    fn timestamp_arithmetic_handles_rollover_and_subsecond() {
        assert_eq!(
            timestamp_plus_seconds("2026-08-09T23:59:59.500000Z", 2),
            "2026-08-10T00:00:01.500000Z"
        );
        assert_eq!(
            timestamp_plus_seconds("2026-12-31T23:59:59.000000Z", 1),
            "2027-01-01T00:00:00.000000Z"
        );
        assert_eq!(
            timestamp_plus_seconds("2024-02-28T00:00:00.000000Z", 86_400),
            "2024-02-29T00:00:00.000000Z"
        );
        assert_eq!(
            timestamp_plus_seconds("2026-08-09T15:00:00.000000Z", -1),
            "2026-08-09T14:59:59.000000Z"
        );
        assert_eq!(
            timestamp_diff_micros("2026-08-09T15:00:00.000000Z", "2026-08-09T15:00:01.500000Z"),
            1_500_000
        );
    }
}
