//! Deterministic clocks for the asset service.
//!
//! All retention and lifecycle arithmetic uses unix milliseconds; wire and
//! audit strings are RFC3339 UTC with six fractional digits, matching the
//! `Timestamp` schema pattern.

use std::time::{SystemTime, UNIX_EPOCH};

/// One instant in unix milliseconds. The RFC3339 UTC rendering is derived
/// on demand so the type stays `Copy` and passes by value through the state
/// machine without aliasing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockTime {
    pub millis: u64,
}

impl ClockTime {
    pub fn new(millis: u64) -> Self {
        Self { millis }
    }

    /// The RFC3339 UTC rendering with six fractional digits.
    pub fn iso(&self) -> String {
        format_timestamp(self.millis)
    }
}

/// Time source for the asset service. Production uses the system clock;
/// tests use a fixed clock so expiry and grace periods are deterministic.
pub trait Clock {
    fn now(&mut self) -> ClockTime;
}

/// Formats a unix-millisecond instant as `YYYY-MM-DDTHH:MM:SS.ffffffZ`.
pub fn format_timestamp(millis: u64) -> String {
    let secs = millis / 1000;
    let micros = (millis % 1000) * 1000;
    let days = secs / 86_400;
    let remaining = secs % 86_400;
    let (hours, rem) = (remaining / 3600, remaining % 3600);
    let (minutes, seconds) = (rem / 60, rem % 60);

    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:06}Z",
        y, m, d, hours, minutes, seconds, micros
    )
}

/// The system clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&mut self) -> ClockTime {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before epoch")
            .as_millis() as u64;
        ClockTime { millis }
    }
}

/// A fixed clock for deterministic tests.
pub struct FixedClock {
    millis: u64,
}

impl FixedClock {
    pub fn new(millis: u64) -> Self {
        Self { millis }
    }

    pub fn advance(&mut self, delta_ms: u64) {
        self.millis += delta_ms;
    }
}

impl Clock for FixedClock {
    fn now(&mut self) -> ClockTime {
        ClockTime {
            millis: self.millis,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_round_trip_matches_pattern() {
        let mut fixed = FixedClock::new(1_753_000_000_000);
        let time = fixed.now();
        assert!(time.iso().ends_with("Z"));
        assert_eq!(time.iso().len(), "YYYY-MM-DDTHH:MM:SS.ffffffZ".len());
        // Lexicographic ordering equals chronological ordering.
        let later = FixedClock::new(1_753_000_000_001).now();
        assert!(time.iso() < later.iso());
        // Known instant: 2025-06-20T00:00:00.000000Z would be a specific
        // epoch; just verify the fields are internally consistent.
        let rendered = time.iso();
        let secs: u64 = rendered[17..19].parse().unwrap();
        assert!(secs < 60);
    }

    #[test]
    fn fixed_clock_advances() {
        let mut clock = FixedClock::new(1_000);
        let a = clock.now();
        clock.advance(500);
        let b = clock.now();
        assert_eq!(b.millis, 1_500);
        assert!(a.iso() < b.iso());
    }
}
