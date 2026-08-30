//! Stable alarm error taxonomy from the Alarm Extension specification §8.
//!
//! The codes are the fixed, wire-stable set the specification says MUST
//! exist. Alarm-, occurrence-, and schedule-specific diagnostic fields belong
//! in `details`, never in the code. `Failpoint` is an internal deterministic
//! crash-injection boundary for the conformance suite; it is never produced
//! in production.
//!
//! The detailed wording here is prose for diagnostics; the stable identity of
//! a failure is its `code`.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AlarmErrorCode {
    InvalidSchedule,
    NonexistentTimezone,
    RevisionConflict,
    IterationBound,
    AlarmLimit,
    RepeatInterval,
    OccurrenceNotFound,
    AlreadyAcknowledged,
    DatabaseUnavailable,
    ClockUnavailable,
    RuntimeOutcomeUnknown,
    Failpoint,
}

impl AlarmErrorCode {
    /// The wire-stable code string for this failure kind.
    pub fn as_str(self) -> &'static str {
        match self {
            AlarmErrorCode::InvalidSchedule => "INVALID_SCHEDULE",
            AlarmErrorCode::NonexistentTimezone => "NONEXISTENT_TIMEZONE",
            AlarmErrorCode::RevisionConflict => "REVISION_CONFLICT",
            AlarmErrorCode::IterationBound => "ITERATION_BOUND",
            AlarmErrorCode::AlarmLimit => "ALARM_LIMIT",
            AlarmErrorCode::RepeatInterval => "REPEAT_INTERVAL",
            AlarmErrorCode::OccurrenceNotFound => "OCCURRENCE_NOT_FOUND",
            AlarmErrorCode::AlreadyAcknowledged => "ALREADY_ACKNOWLEDGED",
            AlarmErrorCode::DatabaseUnavailable => "DATABASE_UNAVAILABLE",
            AlarmErrorCode::ClockUnavailable => "CLOCK_UNAVAILABLE",
            AlarmErrorCode::RuntimeOutcomeUnknown => "RUNTIME_OUTCOME_UNKNOWN",
            AlarmErrorCode::Failpoint => "FAILPOINT",
        }
    }
}

impl std::fmt::Display for AlarmErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An alarm-domain failure with a stable code and structured details.
#[derive(Debug, Clone)]
pub struct AlarmError {
    pub code: AlarmErrorCode,
    pub message: String,
    pub details: serde_json::Map<String, serde_json::Value>,
}

impl AlarmError {
    pub fn new(code: AlarmErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: serde_json::Map::new(),
        }
    }

    pub fn with_details(
        code: AlarmErrorCode,
        message: impl Into<String>,
        details: serde_json::Map<String, serde_json::Value>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            details,
        }
    }

    /// The common error-envelope body: `{ "code", "message", "details" }` in
    /// stable field order.
    pub fn envelope(&self) -> serde_json::Value {
        let mut object = serde_json::Map::new();
        object.insert(
            "code".to_string(),
            serde_json::Value::String(self.code.as_str().to_string()),
        );
        object.insert(
            "message".to_string(),
            serde_json::Value::String(self.message.clone()),
        );
        object.insert(
            "details".to_string(),
            serde_json::Value::Object(self.details.clone()),
        );
        serde_json::Value::Object(object)
    }
}

impl std::fmt::Display for AlarmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AlarmError {}

pub type AlarmResult<T> = Result<T, AlarmError>;

pub fn detail(
    key: &str,
    value: impl Into<serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut details = serde_json::Map::new();
    details.insert(key.to_string(), value.into());
    details
}
