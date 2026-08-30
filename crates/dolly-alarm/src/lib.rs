//! Dolly Alarm extension core (WP-014).
//!
//! The closed, deterministic alarm scheduler/persistence core: one
//! injected-time scheduler over a durable SQLite store, versioned
//! timezone-rule evaluation, exact cron/once/interval occurrence
//! calculation with DST gap/fold policies, durable occurrence identity,
//! claim/lease/ack/result state, misfire semantics, and idempotent action
//! replay.
//!
//! Authority always flows from a committed Alarm Action (exactly one owner,
//! `org.dolly.alarm`) through the durable `AlarmRecord`, `Occurrence`, and
//! claim, to a typed wakeup/output premise. The wakeup/clock never creates
//! Action authority; no Page/cursor is mutated and Channel delivery is out of
//! scope. Runtime Clock/wakeup/Action registration belongs to a later
//! integrator; everything here takes explicit deterministic time and tzdb
//! rule inputs.

pub mod action;
pub mod clock;
pub mod cron;
pub mod error;
pub mod failpoint;
pub mod occurrence;
pub mod record;
pub mod scheduler;
pub mod store;
pub mod time;
pub mod tzdb;

pub use action::{ActionCommand, ActionResult, CommittedAction, parse_command, validate_committed};
pub use clock::{Clock, FixedClock, SharedFixedClock};
pub use error::{AlarmError, AlarmErrorCode};
pub use failpoint::{Failpoint, FailpointBoundary};
pub use occurrence::{DstFoldPolicy, DstGapPolicy, Schedule};
pub use record::{
    ALARM_EXTENSION_ID, AlarmRecord, DeliveryShape, FrozenAlarmConfig, MisfirePolicy, RawDelivery,
    RawSchedule, ScheduleShape,
};
pub use scheduler::{FiredEvent, Outcome, Scheduler, SettleReport, WakeupPremise};
pub use store::{AlarmStore, Claim, MisfireBasis, Occurrence, OccurrenceKind, OccurrenceState};
pub use time::{CivilTime, UsInstant, format_utc_iso6, parse_utc_timestamp_us};
pub use tzdb::{FixedZone, FixtureZoneRulesProvider, ZoneRulesProvider};
