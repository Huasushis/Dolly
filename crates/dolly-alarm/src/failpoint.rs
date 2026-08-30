//! Deterministic crash-injection boundaries.
//!
//! Every durable effect in the scheduler runs inside one immediate SQLite
//! transaction. A failpoint armed at a named boundary makes the enclosing
//! effect abort before (or at) that write, so the transaction rolls back and
//! the store keeps its exact pre-effect state — a deterministic crash before
//! the effect. A crash *after* an effect is inherent to the state machine
//! (e.g. a committed claim with no completion) and is exercised by driving
//! only part of a transition, then recovering.
//!
//! Failpoints are a test-only surface; production never arms them.

/// The named effect boundary a failpoint aborts at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FailpointBoundary {
    /// Abort before the first write of a create action.
    BeforeCreate,
    /// Abort before the first write of an update action.
    BeforeUpdate,
    /// Abort before the first write of a delete action.
    BeforeDelete,
    /// Abort before the first write of a snooze action.
    BeforeSnooze,
    /// Abort before the first write of an acknowledge action.
    BeforeAcknowledge,
    /// Abort before the claim compare-and-set.
    BeforeClaim,
    /// Abort before the completion compare-and-set.
    BeforeComplete,
    /// Abort before the release compare-and-set.
    BeforeRelease,
    /// Abort before the misfire outcome is persisted.
    BeforeMisfire,
    /// Abort before the next-occurrence roll inserts its rows.
    BeforeRoll,
    /// Abort before expired-claim reconciliation writes.
    BeforeReconcile,
    /// Abort before the retention prune writes.
    BeforePrune,
}

impl FailpointBoundary {
    pub fn as_str(self) -> &'static str {
        match self {
            FailpointBoundary::BeforeCreate => "before_create",
            FailpointBoundary::BeforeUpdate => "before_update",
            FailpointBoundary::BeforeDelete => "before_delete",
            FailpointBoundary::BeforeSnooze => "before_snooze",
            FailpointBoundary::BeforeAcknowledge => "before_acknowledge",
            FailpointBoundary::BeforeClaim => "before_claim",
            FailpointBoundary::BeforeComplete => "before_complete",
            FailpointBoundary::BeforeRelease => "before_release",
            FailpointBoundary::BeforeMisfire => "before_misfire",
            FailpointBoundary::BeforeRoll => "before_roll",
            FailpointBoundary::BeforeReconcile => "before_reconcile",
            FailpointBoundary::BeforePrune => "before_prune",
        }
    }
}

/// A single-use or armed failpoint.
#[derive(Debug, Clone)]
pub struct Failpoint {
    boundary: FailpointBoundary,
}

impl Failpoint {
    pub fn new(boundary: FailpointBoundary) -> Self {
        Self { boundary }
    }

    pub fn boundary(&self) -> FailpointBoundary {
        self.boundary
    }

    /// When armed at `boundary`, return the deterministic failure that aborts
    /// the enclosing transaction; otherwise `None`.
    pub fn trip(&self, boundary: FailpointBoundary) -> Option<crate::error::AlarmError> {
        if self.boundary == boundary {
            return Some(crate::error::AlarmError::new(
                crate::error::AlarmErrorCode::Failpoint,
                format!("injected crash at boundary {}", boundary.as_str()),
            ));
        }
        None
    }
}
