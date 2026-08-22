//! Host-owned ports injected into recovery (tool-broker §6).
//!
//! The pure decision [`recover_operation`] reads exactly three facts: the
//! generation readiness of the frozen server, the expiry of the stored
//! deadline, and whether the exclusive send gate establishes zero-byte
//! proof. These ports let the Host answer those three questions without
//! creating a downstream (ACK/result/error/absence) authority. They are
//! defined here so the coordinator stays free of transport/Host/network.

use std::time::SystemTime;

use dolly_tool_broker::{RecoveryFacts, ToolCallLedgerRecord};

/// Host-owned answer to "is the frozen generation still Ready for this
/// retained revision?" (tool-broker §4/§6).
pub trait GenerationReadiness {
    /// Whether the exact frozen generation of `(module_id, server_id)` is
    /// still Ready. `false` makes an `AUTHORIZED` row fail closed as
    /// `TOOL_DISPATCH_NOT_APPLIED` (given zero-byte proof).
    fn exact_generation_ready(
        &self,
        module_id: &str,
        tool_server_id: &str,
        tool_server_generation: u64,
    ) -> bool;
}

/// Host-owned wall clock for deadline comparison (tool-broker §6).
pub trait Clock {
    /// The current wall time; compared against the binding's stored
    /// `authorized_deadline`.
    fn now(&self) -> SystemTime;
}

/// Per-row `RecoveryFacts` production. Implementations MUST NOT read any
/// downstream ACK, result, error, or absence as a fact.
pub trait RecoveryFactsProvider {
    /// Build the verified facts for one nonterminal row.
    fn facts_for(&self, row: &ToolCallLedgerRecord) -> RecoveryFacts;
}

/// Composite [`RecoveryFactsProvider`] from Host-owned readiness, clock, and
/// zero-byte proof inputs. `zero_bytes_proved` is the result of the Host's
/// exclusive write-lock recheck on the fence.
pub struct FencedFactsProvider<'a> {
    /// Whether the exclusive send gate proves zero bytes were eligible or
    /// sent (Host-owned).
    pub zero_bytes_proved: bool,
    /// Host-owned generation readiness.
    pub readiness: &'a dyn GenerationReadiness,
    /// Host-owned clock for deadline expiry.
    pub clock: &'a dyn Clock,
}

impl RecoveryFactsProvider for FencedFactsProvider<'_> {
    fn facts_for(&self, row: &ToolCallLedgerRecord) -> RecoveryFacts {
        let binding = &row.operation_binding;
        RecoveryFacts {
            zero_bytes_proved: self.zero_bytes_proved,
            exact_generation_ready: self.readiness.exact_generation_ready(
                &binding.module_id,
                &binding.tool_server_id,
                binding.tool_server_generation,
            ),
            deadline_expired: deadline_expired(&binding.authorized_deadline, self.clock.now()),
        }
    }
}

/// Strict RFC 3339 (UTC, `Z`) parse to `SystemTime`. Any unparseable
/// deadline is reported as expired (fail-closed: never dispatches on an
/// unreadable deadline).
fn deadline_expired(payload: &str, now: SystemTime) -> bool {
    let Some(deadline) = parse_rfc3339_utc(payload) else {
        return true;
    };
    // Expired means strictly after the deadline; equal (deadline instant)
    // is still live.
    match now.duration_since(deadline) {
        Ok(elapsed) => !elapsed.is_zero(),
        Err(_) => false,
    }
}

fn parse_rfc3339_utc(payload: &str) -> Option<SystemTime> {
    let b = payload.as_bytes();
    if b.len() < 20 {
        return None;
    }
    let digit = |c: u8| -> Option<u8> {
        if c.is_ascii_digit() {
            Some(c - b'0')
        } else {
            None
        }
    };
    let year = u64::from(digit(b[0])?) * 1000
        + u64::from(digit(b[1])?) * 100
        + u64::from(digit(b[2])?) * 10
        + u64::from(digit(b[3])?);
    if b[4] != b'-' {
        return None;
    }
    let month = u64::from(digit(b[5])?) * 10 + u64::from(digit(b[6])?);
    if b[7] != b'-' {
        return None;
    }
    let day = u64::from(digit(b[8])?) * 10 + u64::from(digit(b[9])?);
    if b[10] != b'T' {
        return None;
    }
    let hour = u64::from(digit(b[11])?) * 10 + u64::from(digit(b[12])?);
    if b[13] != b':' {
        return None;
    }
    let minute = u64::from(digit(b[14])?) * 10 + u64::from(digit(b[15])?);
    if b[16] != b':' {
        return None;
    }
    let second = u64::from(digit(b[17])?) * 10 + u64::from(digit(b[18])?);
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut i = 19;
    let mut nanos = 0u32;
    let mut places = 0u32;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            if places < 9 {
                nanos = nanos * 10 + u32::from(digit(b[i])?);
            }
            places += 1;
            i += 1;
        }
    }
    if i >= b.len() || b[i] != b'Z' || i + 1 != b.len() {
        return None;
    }
    if month == 0 || month > 12 || day == 0 || day > 31 {
        return None;
    }
    let days = days_from_civil(year as i64, month as i64, day as i64)?;
    let total = days * 86400 + hour as i64 * 3600 + minute as i64 * 60 + second as i64;
    let mut when = SystemTime::UNIX_EPOCH
        .checked_add(std::time::Duration::from_secs(u64::try_from(total).ok()?))?;
    if nanos != 0 {
        when = when.checked_add(std::time::Duration::from_nanos(u64::from(nanos)))?;
    }
    Some(when)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
    // Howard Hinnant's civil-from-days algorithm; covers the whole year
    // range representable by i64 seconds.
    if !(1..=12).contains(&m) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadline_parse_and_expiry() {
        let before = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_699_999_999);
        let at = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let after = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_001);
        assert!(!deadline_expired("2023-11-14T22:13:20.000000Z", at));
        assert!(!deadline_expired("2023-11-14T22:13:20Z", at));
        assert!(deadline_expired("2023-11-14T22:13:20Z", after));
        assert!(!deadline_expired("2023-11-14T22:13:20Z", before));
        assert!(deadline_expired("not-a-date", at));
    }
}
