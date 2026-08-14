use serde::de::{self, Deserialize, Deserializer};
use serde::ser::{Serialize, Serializer};
use std::fmt;
use std::str::FromStr;

/// A UTC timestamp in the exact form `YYYY-MM-DDTHH:MM:SS.ffffffZ`.
///
/// Six fractional digits are required. Leap seconds, offsets, lowercase
/// spellings, and impossible dates are rejected. The date must be a real
/// proleptic-Gregorian calendar date.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp {
    raw: String,
}

impl Timestamp {
    fn parse(s: &str) -> Result<Self, String> {
        // Exact pattern: YYYY-MM-DDTHH:MM:SS.ffffffZ
        if s.len() != 27 {
            return Err(format!(
                "Timestamp must be exactly 27 characters (YYYY-MM-DDTHH:MM:SS.ffffffZ), got {}",
                s.len()
            ));
        }
        // Must end with Z (uppercase)
        if !s.ends_with('Z') {
            return Err("Timestamp must end with uppercase 'Z'".to_string());
        }
        // Check character positions
        let b = s.as_bytes();
        // YYYY-MM-DDTHH:MM:SS.ffffffZ
        // 0123456789012345678901234567
        // Positions: 4=-, 7=-, 10=T, 13=:, 16=:, 19=., 26=Z
        if b[4] != b'-'
            || b[7] != b'-'
            || b[10] != b'T'
            || b[13] != b':'
            || b[16] != b':'
            || b[19] != b'.'
        {
            return Err("Timestamp has invalid structure".to_string());
        }
        // All other positions must be digits
        for (i, &c) in b.iter().enumerate() {
            if i == 4 || i == 7 || i == 10 || i == 13 || i == 16 || i == 19 || i == 26 {
                continue;
            }
            if !c.is_ascii_digit() {
                return Err(format!("Timestamp has non-digit at position {i}"));
            }
        }

        // Parse fields
        let year: u32 = s[0..4].parse().unwrap();
        let month: u32 = s[5..7].parse().unwrap();
        let day: u32 = s[8..10].parse().unwrap();
        let hour: u32 = s[11..13].parse().unwrap();
        let minute: u32 = s[14..16].parse().unwrap();
        let second: u32 = s[17..19].parse().unwrap();
        // fractional digits already validated as 6 digits

        // Validate ranges
        if !(1..=12).contains(&month) {
            return Err(format!("invalid month: {month}"));
        }
        if day < 1 || day > days_in_month(year, month) {
            return Err(format!("invalid day: {day} for {year}-{month:02}"));
        }
        if hour > 23 {
            return Err(format!("invalid hour: {hour}"));
        }
        if minute > 59 {
            return Err(format!("invalid minute: {minute}"));
        }
        // Reject leap seconds (second 60)
        if second > 59 {
            return Err(format!(
                "leap seconds are not permitted, got second={second}"
            ));
        }

        Ok(Self { raw: s.to_owned() })
    }

    pub fn as_str(&self) -> &str {
        &self.raw
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.raw)
    }
}

impl fmt::Debug for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Timestamp({})", self.raw)
    }
}

impl FromStr for Timestamp {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

impl Serialize for Timestamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.raw)
    }
}

impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        s.parse::<Self>().map_err(de::Error::custom)
    }
}

fn is_leap_year(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(year) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}
