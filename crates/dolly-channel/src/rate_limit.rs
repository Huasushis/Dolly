//! Deterministic outbound rate limiting and bounded pending admission.
//!
//! Rate limiting uses integer token buckets over the injected clock
//! (microsecond precision) so every admission decision is reproducible.

use crate::clock::{Clock, timestamp_total_micros};
use crate::config::OutboundLimits;
use crate::error::{ChannelError, ChannelOutcome, codes};

/// A per-session token bucket with exact integer arithmetic.
#[derive(Debug, Clone, Default)]
pub struct TokenBucket {
    /// Tokens scaled by 1_000_000 (one token = one piece).
    tokens: i64,
    last_refill_micros: Option<i64>,
}

impl TokenBucket {
    /// Try to take `count` pieces now. Bucket capacity is one second of
    /// allowance (`max_pieces_per_second`), refilled continuously.
    pub fn try_take(
        &mut self,
        now_micros: i64,
        max_pieces_per_second: u64,
        count: u64,
    ) -> bool {
        let capacity = max_pieces_per_second as i64 * 1_000_000;
        if capacity <= 0 {
            return count == 0;
        }
        if let Some(last) = self.last_refill_micros {
            if now_micros >= last {
                let elapsed = now_micros - last;
                self.tokens = (self.tokens + elapsed * max_pieces_per_second as i64)
                    .min(capacity);
            }
        } else {
            self.tokens = capacity;
        }
        self.last_refill_micros = Some(now_micros);
        let cost = count as i64 * 1_000_000;
        if self.tokens >= cost {
            self.tokens -= cost;
            true
        } else {
            false
        }
    }
}

/// Admission control combining token buckets and bounded pending sends.
#[derive(Debug, Clone, Default)]
pub struct OutboundAdmission {
    buckets: std::collections::BTreeMap<String, TokenBucket>,
}

impl OutboundAdmission {
    pub fn new() -> Self {
        Self::default()
    }

    /// Verify that `piece_count` pieces with `session_id` are admissible now.
    ///
    /// - per-session token bucket at `limits.max_pieces_per_second_per_session`;
    /// - bounded pending sends per session and ledger-wide.
    ///
    /// On failure returns `CHANNEL_RATE_LIMITED` (`retryable: true`,
    /// `not_applied`) so the caller deadline may retry later.
    pub fn admit(
        &mut self,
        clock: &dyn Clock,
        limits: &OutboundLimits,
        session_id: &str,
        piece_count: u64,
        pending_per_session: usize,
        pending_total: usize,
    ) -> Result<(), ChannelError> {
        if pending_total >= limits.max_pending_total {
            return Err(ChannelError::new(
                codes::RATE_LIMITED,
                true,
                ChannelOutcome::NotApplied,
                format!(
                    "outbound pending total {} reached limit {}",
                    pending_total, limits.max_pending_total
                ),
            ));
        }
        if pending_per_session >= limits.max_pending_per_session {
            return Err(ChannelError::new(
                codes::RATE_LIMITED,
                true,
                ChannelOutcome::NotApplied,
                format!(
                    "outbound pending for session {session_id} reached limit {}",
                    limits.max_pending_per_session
                ),
            ));
        }
        let now = timestamp_total_micros(clock.now().as_str());
        let bucket = self.buckets.entry(session_id.to_string()).or_default();
        if !bucket.try_take(now, limits.max_pieces_per_second_per_session, piece_count) {
            return Err(ChannelError::new(
                codes::RATE_LIMITED,
                true,
                ChannelOutcome::NotApplied,
                format!(
                    "per-session piece rate {}/s exceeded for session {session_id}",
                    limits.max_pieces_per_second_per_session
                ),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::VirtualClock;
    use std::str::FromStr;
    use dolly_core_domain::Timestamp;

    fn ts(s: &str) -> Timestamp {
        Timestamp::from_str(s).unwrap()
    }

    #[test]
    fn bucket_allows_rate_then_blocks_until_refill() {
        let mut clock = VirtualClock::at(ts("2026-08-09T15:00:00.000000Z"));
        let limits = OutboundLimits {
            max_pieces_per_second_per_session: 2,
            max_pending_per_session: 8,
            max_pending_total: 64,
            unknown_after_seconds: 60,
        };
        let mut admission = OutboundAdmission::new();
        // Burst of 2 allowed (capacity = 1 second of allowance).
        assert!(admission
            .admit(&clock, &limits, "s1", 2, 0, 0)
            .is_ok());
        // Third piece in the same second is blocked.
        assert!(admission.admit(&clock, &limits, "s1", 1, 0, 0).is_err());
        clock.advance_seconds(1);
        assert!(admission.admit(&clock, &limits, "s1", 1, 0, 0).is_ok());
    }
}
