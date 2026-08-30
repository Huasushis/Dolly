//! Injected time for the alarm scheduler.
//!
//! The scheduler never reads the ambient wall clock, sleeps, or polls; the
//! runtime bridge injects a `Clock`, and tests drive a fixed, advanceable
//! virtual clock. All instants are UTC microseconds. `ClockUnavailable` is a
//! stable alarm error code the runtime bridge can raise if its injected clock
//! fails; this crate's own clocks are infallible.

use crate::error::{AlarmError, AlarmErrorCode};
use crate::time::UsInstant;

/// Time source for the alarm scheduler.
pub trait Clock: Send {
    /// The current UTC instant in microseconds.
    fn now_us(&self) -> Result<UsInstant, AlarmError>;
}

/// A fixed virtual clock; the whole scheduler advances deterministically.
#[derive(Debug, Clone, Copy)]
pub struct FixedClock {
    now_us: UsInstant,
}

impl FixedClock {
    pub fn new(now_us: UsInstant) -> Self {
        Self { now_us }
    }

    pub fn advance(&mut self, delta_us: i64) {
        self.now_us += delta_us;
    }

    pub fn set(&mut self, now_us: UsInstant) {
        self.now_us = now_us;
    }

    pub fn value(&self) -> UsInstant {
        self.now_us
    }
}

impl Clock for FixedClock {
    fn now_us(&self) -> Result<UsInstant, AlarmError> {
        Ok(self.now_us)
    }
}

/// A failing clock for proving `CLOCK_UNAVAILABLE` propagation.
pub struct UnavailableClock;

impl Clock for UnavailableClock {
    fn now_us(&self) -> Result<UsInstant, AlarmError> {
        Err(AlarmError::new(
            AlarmErrorCode::ClockUnavailable,
            "injected clock unavailable",
        ))
    }
}

/// Shared, advanceable virtual clock for multi-threaded conformance tests.
#[derive(Clone)]
pub struct SharedFixedClock {
    inner: std::sync::Arc<parking_lot::Mutex<UsInstant>>,
}

impl SharedFixedClock {
    pub fn new(now_us: UsInstant) -> Self {
        Self {
            inner: std::sync::Arc::new(parking_lot::Mutex::new(now_us)),
        }
    }

    pub fn advance(&self, delta_us: i64) {
        *self.inner.lock() += delta_us;
    }

    pub fn set(&self, now_us: UsInstant) {
        *self.inner.lock() = now_us;
    }

    pub fn value(&self) -> UsInstant {
        *self.inner.lock()
    }
}

impl Clock for SharedFixedClock {
    fn now_us(&self) -> Result<UsInstant, AlarmError> {
        Ok(*self.inner.lock())
    }
}
