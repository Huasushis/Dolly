use crate::security::redact_log_value;
use dolly_canonical_json::{CanonicalBytes, ParseLimits, canonicalize, deserialize_core_json};
use dolly_core_domain::Timestamp;
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, VecDeque};
use thiserror::Error;

/// Hard ceilings keep a caller-supplied buffer finite even when it is not
/// using the default policy.
pub const MAX_LOG_EVENTS: usize = 4_096;
pub const MAX_LOG_EVENT_BYTES: usize = 64 * 1024;
pub const MAX_LOG_TOTAL_BYTES: usize = 4 * 1024 * 1024;

/// The finite structured-log classes defined by the observability contract.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
    Payload,
}

impl LogLevel {
    fn is_evictable(self) -> bool {
        matches!(self, Self::Trace | Self::Debug | Self::Info)
    }

    fn eviction_rank(self) -> Option<u8> {
        match self {
            Self::Trace => Some(0),
            Self::Debug => Some(1),
            Self::Info => Some(2),
            Self::Error | Self::Warn | Self::Payload => None,
        }
    }
}

/// Explicit finite limits for one process-local telemetry buffer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LogLimits {
    max_events: usize,
    max_event_bytes: usize,
    max_total_bytes: usize,
}

impl LogLimits {
    pub const fn new(
        max_events: usize,
        max_event_bytes: usize,
        max_total_bytes: usize,
    ) -> Result<Self, LogError> {
        if max_events == 0
            || max_events > MAX_LOG_EVENTS
            || max_event_bytes == 0
            || max_event_bytes > MAX_LOG_EVENT_BYTES
            || max_total_bytes == 0
            || max_total_bytes > MAX_LOG_TOTAL_BYTES
        {
            return Err(LogError::InvalidLimits);
        }
        Ok(Self {
            max_events,
            max_event_bytes,
            max_total_bytes,
        })
    }

    pub const fn max_events(self) -> usize {
        self.max_events
    }

    pub const fn max_event_bytes(self) -> usize {
        self.max_event_bytes
    }

    pub const fn max_total_bytes(self) -> usize {
        self.max_total_bytes
    }
}

impl Default for LogLimits {
    fn default() -> Self {
        Self {
            max_events: 1_024,
            max_event_bytes: 16 * 1024,
            max_total_bytes: 4 * 1024 * 1024,
        }
    }
}

/// Authorization required before a `payload` log can be accepted.
///
/// Payload logs are disabled unless this value supplies a non-empty scope,
/// future expiry, finite byte limit, positive retention, and an explicit
/// operator warning. The authorization is a policy value, not a capability.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayloadAuthorization {
    scope: String,
    expires_at: Timestamp,
    max_bytes: usize,
    retention_seconds: u64,
    operator_warning: bool,
}

impl PayloadAuthorization {
    pub fn new(
        scope: impl Into<String>,
        expires_at: Timestamp,
        max_bytes: usize,
        retention_seconds: u64,
        operator_warning: bool,
    ) -> Result<Self, LogError> {
        let scope = scope.into();
        if scope.is_empty() || scope.len() > 255 {
            return Err(LogError::InvalidPayloadAuthorization(
                "payload scope must be 1..=255 UTF-8 bytes",
            ));
        }
        if max_bytes == 0 {
            return Err(LogError::InvalidPayloadAuthorization(
                "payload max_bytes must be positive",
            ));
        }
        if retention_seconds == 0 {
            return Err(LogError::InvalidPayloadAuthorization(
                "payload retention must be positive",
            ));
        }
        if !operator_warning {
            return Err(LogError::InvalidPayloadAuthorization(
                "payload authorization requires an operator warning",
            ));
        }
        Ok(Self {
            scope,
            expires_at,
            max_bytes,
            retention_seconds,
            operator_warning,
        })
    }

    pub fn scope(&self) -> &str {
        &self.scope
    }

    pub fn expires_at(&self) -> &Timestamp {
        &self.expires_at
    }

    pub const fn max_bytes(&self) -> usize {
        self.max_bytes
    }

    pub const fn retention_seconds(&self) -> u64 {
        self.retention_seconds
    }

    pub const fn operator_warning(&self) -> bool {
        self.operator_warning
    }
}

/// One structured log object. The fields are data only; they cannot carry a
/// Host capability, grant, reservation, execution premise, or effect handle.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StructuredLogEvent {
    event_name: String,
    schema_version: u16,
    severity: LogLevel,
    event_time: Timestamp,
    sequence: u64,
    producer_identity: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    fields: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "is_false")]
    truncated: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StructuredLogEventWire {
    event_name: String,
    schema_version: u16,
    severity: LogLevel,
    event_time: Timestamp,
    sequence: u64,
    producer_identity: String,
    #[serde(default)]
    fields: BTreeMap<String, Value>,
    #[serde(default)]
    truncated: bool,
}

impl<'de> Deserialize<'de> for StructuredLogEvent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = StructuredLogEventWire::deserialize(deserializer)?;
        let mut event = Self::new(
            wire.event_name,
            wire.schema_version,
            wire.severity,
            wire.event_time,
            wire.sequence,
            wire.producer_identity,
            wire.fields,
        )
        .map_err(de::Error::custom)?;
        event.truncated = wire.truncated;
        Ok(event)
    }
}
impl StructuredLogEvent {
    pub fn new(
        event_name: impl Into<String>,
        schema_version: u16,
        severity: LogLevel,
        event_time: Timestamp,
        sequence: u64,
        producer_identity: impl Into<String>,
        fields: BTreeMap<String, Value>,
    ) -> Result<Self, LogError> {
        let event_name = event_name.into();
        let producer_identity = producer_identity.into();
        validate_text(&event_name, "event_name")?;
        validate_text(&producer_identity, "producer_identity")?;
        if schema_version == 0 {
            return Err(LogError::InvalidEvent(
                "schema_version must be positive".to_owned(),
            ));
        }
        if sequence == 0 || sequence > MAX_SAFE_JSON_INTEGER {
            return Err(LogError::InvalidEvent(
                "sequence must be in the safe positive integer range".to_owned(),
            ));
        }

        let mut raw_fields = Map::with_capacity(fields.len());
        for (key, value) in fields {
            validate_text(&key, "field name")?;
            raw_fields.insert(key, value);
        }
        let safe_fields = match redact_log_value(&Value::Object(raw_fields)) {
            Some(Value::Object(object)) => object.into_iter().collect(),
            _ => unreachable!("a structured object remains an object after redaction"),
        };
        let event = Self {
            event_name,
            schema_version,
            severity,
            event_time,
            sequence,
            producer_identity,
            fields: safe_fields,
            truncated: false,
        };
        event.validate_error_fields()?;
        Ok(event)
    }

    pub fn event_name(&self) -> &str {
        &self.event_name
    }

    pub const fn schema_version(&self) -> u16 {
        self.schema_version
    }

    pub const fn severity(&self) -> LogLevel {
        self.severity
    }

    pub fn event_time(&self) -> &Timestamp {
        &self.event_time
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn producer_identity(&self) -> &str {
        &self.producer_identity
    }

    pub fn fields(&self) -> &BTreeMap<String, Value> {
        &self.fields
    }

    pub const fn is_truncated(&self) -> bool {
        self.truncated
    }

    pub fn canonical_bytes(&self) -> Result<CanonicalBytes, LogError> {
        canonicalize(self)
            .map(|(bytes, _)| bytes)
            .map_err(|error| LogError::Canonical(error.to_string()))
    }

    /// Recover one complete canonical event after applying the same
    /// constructor redaction rules. Partial or non-canonical bytes are not
    /// accepted as a log event.
    pub fn recover_from_bytes(input: &[u8]) -> Result<Self, LogError> {
        if input.is_empty() || input.len() > MAX_LOG_EVENT_BYTES {
            return Err(LogError::InvalidEvent(
                "log event bytes exceed the finite recovery limit".to_owned(),
            ));
        }
        let event: Self = deserialize_core_json(input, ParseLimits::new(64).expect("64 is valid"))
            .map_err(|error| LogError::InvalidEvent(error.to_string()))?;
        let canonical = event.canonical_bytes()?;
        if canonical.as_bytes() != input {
            return Err(LogError::InvalidEvent(
                "log event bytes are not canonical JSON".to_owned(),
            ));
        }
        Ok(event)
    }

    fn validate_error_fields(&self) -> Result<(), LogError> {
        if self.severity != LogLevel::Error {
            return Ok(());
        }
        for required in ["error_code", "phase", "retryable", "outcome"] {
            if !self.fields.contains_key(required) {
                return Err(LogError::InvalidEvent(format!(
                    "error events require field '{required}'"
                )));
            }
        }
        Ok(())
    }

    fn truncated_to(&self, max_bytes: usize) -> Result<Self, LogError> {
        let mut candidate = self.clone();
        candidate.truncated = true;
        let original_fields = candidate.fields.clone();

        let mut low = 0usize;
        let mut high = max_bytes;
        let mut best: Option<Self> = None;
        while low <= high {
            let limit = low + (high - low) / 2;
            candidate.fields = truncate_fields(&original_fields, limit);
            if candidate.canonical_bytes()?.as_bytes().len() <= max_bytes {
                best = Some(candidate.clone());
                low = limit.saturating_add(1);
            } else if limit == 0 {
                break;
            } else {
                high = limit - 1;
            }
        }

        if let Some(candidate) = best {
            return Ok(candidate);
        }

        candidate.fields = BTreeMap::new();
        if candidate.canonical_bytes()?.as_bytes().len() <= max_bytes {
            Ok(candidate)
        } else {
            Err(LogError::EventTooLarge {
                actual: self.canonical_bytes()?.as_bytes().len(),
                limit: max_bytes,
            })
        }
    }
}

fn truncate_fields(
    fields: &BTreeMap<String, Value>,
    max_string_chars: usize,
) -> BTreeMap<String, Value> {
    fields
        .iter()
        .map(|(key, value)| (key.clone(), truncate_value(value, max_string_chars)))
        .collect()
}

fn truncate_value(value: &Value, max_string_chars: usize) -> Value {
    match value {
        Value::String(string) => Value::String(string.chars().take(max_string_chars).collect()),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| truncate_value(value, max_string_chars))
                .collect(),
        ),
        Value::Object(object) => {
            let mut truncated = Map::with_capacity(object.len());
            for (key, value) in object {
                truncated.insert(key.clone(), truncate_value(value, max_string_chars));
            }
            Value::Object(truncated)
        }
        _ => value.clone(),
    }
}

/// Result of attempting to append one event to a bounded buffer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LogPushOutcome {
    Stored { truncated: bool },
    Dropped { dropped_events: u64 },
}

/// A process-local bounded log buffer. It is intentionally non-authoritative:
/// dropping or delaying entries cannot affect Core state or execution.
#[derive(Debug)]
pub struct BoundedLogBuffer {
    limits: LogLimits,
    entries: VecDeque<StoredLogEvent>,
    total_bytes: usize,
    dropped_events: u64,
    last_sequence_by_producer: BTreeMap<String, u64>,
    payload_authorization: Option<PayloadAuthorization>,
}

#[derive(Clone, Debug)]
struct StoredLogEvent {
    event: StructuredLogEvent,
    bytes: CanonicalBytes,
}

impl BoundedLogBuffer {
    pub fn new(limits: LogLimits) -> Self {
        Self {
            limits,
            entries: VecDeque::new(),
            total_bytes: 0,
            dropped_events: 0,
            last_sequence_by_producer: BTreeMap::new(),
            payload_authorization: None,
        }
    }

    pub fn with_payload_authorization(
        limits: LogLimits,
        authorization: PayloadAuthorization,
    ) -> Result<Self, LogError> {
        if authorization.max_bytes() > limits.max_event_bytes() {
            return Err(LogError::InvalidPayloadAuthorization(
                "payload max_bytes cannot exceed max_event_bytes",
            ));
        }
        let mut buffer = Self::new(limits);
        buffer.payload_authorization = Some(authorization);
        Ok(buffer)
    }

    pub fn limits(&self) -> LogLimits {
        self.limits
    }

    pub fn push(&mut self, event: StructuredLogEvent) -> Result<LogPushOutcome, LogError> {
        if let Some(last) = self
            .last_sequence_by_producer
            .get(event.producer_identity())
            .copied()
        {
            if event.sequence() <= last {
                return Err(LogError::SequenceRegression {
                    producer: event.producer_identity().to_owned(),
                    previous: last,
                    current: event.sequence(),
                });
            }
        }

        let mut event = event;
        let mut bytes = event.canonical_bytes()?;
        let event_limit = if event.severity() == LogLevel::Payload {
            let Some(authorization) = self.payload_authorization.as_ref() else {
                return Err(LogError::PayloadDisabled);
            };
            if event.event_time() > authorization.expires_at() {
                return Err(LogError::PayloadExpired);
            }
            self.limits.max_event_bytes().min(authorization.max_bytes())
        } else {
            self.limits.max_event_bytes()
        };

        if bytes.as_bytes().len() > event_limit {
            if event.severity() != LogLevel::Payload {
                return Err(LogError::EventTooLarge {
                    actual: bytes.as_bytes().len(),
                    limit: event_limit,
                });
            }
            event = event.truncated_to(event_limit)?;
            bytes = event.canonical_bytes()?;
        }

        let stored = StoredLogEvent {
            event: event.clone(),
            bytes,
        };
        let incoming_bytes = stored.bytes.as_bytes().len();
        while self.entries.len() >= self.limits.max_events()
            || self.total_bytes.saturating_add(incoming_bytes) > self.limits.max_total_bytes()
        {
            let Some(index) = self.oldest_evictable_index() else {
                if event.severity().is_evictable() {
                    self.dropped_events = self.dropped_events.saturating_add(1);
                    self.last_sequence_by_producer
                        .insert(event.producer_identity().to_owned(), event.sequence());
                    return Ok(LogPushOutcome::Dropped {
                        dropped_events: self.dropped_events,
                    });
                }
                return Err(LogError::BufferFull);
            };
            let removed = self
                .entries
                .remove(index)
                .expect("eviction index was obtained from the same queue");
            self.total_bytes = self
                .total_bytes
                .saturating_sub(removed.bytes.as_bytes().len());
            self.dropped_events = self.dropped_events.saturating_add(1);
        }

        let truncated = event.is_truncated();
        self.total_bytes = self.total_bytes.saturating_add(incoming_bytes);
        self.entries.push_back(stored);
        self.last_sequence_by_producer
            .insert(event.producer_identity().to_owned(), event.sequence());
        Ok(LogPushOutcome::Stored { truncated })
    }

    fn oldest_evictable_index(&self) -> Option<usize> {
        for rank in 0..=2 {
            let index = self
                .entries
                .iter()
                .position(|stored| stored.event.severity().eviction_rank() == Some(rank));
            if index.is_some() {
                return index;
            }
        }
        None
    }

    pub fn entries(&self) -> impl ExactSizeIterator<Item = &StructuredLogEvent> {
        self.entries.iter().map(|stored| &stored.event)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub const fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    pub const fn dropped_events(&self) -> u64 {
        self.dropped_events
    }

    /// Remove entries for export without changing per-producer sequence state.
    pub fn drain(&mut self) -> Vec<StructuredLogEvent> {
        self.total_bytes = 0;
        self.entries.drain(..).map(|stored| stored.event).collect()
    }
    pub const fn is_authoritative(&self) -> bool {
        false
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

fn validate_text(value: &str, label: &str) -> Result<(), LogError> {
    if value.is_empty() || value.len() > 255 {
        return Err(LogError::InvalidEvent(format!(
            "{label} must be 1..=255 UTF-8 bytes"
        )));
    }
    Ok(())
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum LogError {
    #[error("invalid log limits")]
    InvalidLimits,
    #[error("invalid payload authorization: {0}")]
    InvalidPayloadAuthorization(&'static str),
    #[error("invalid structured log event: {0}")]
    InvalidEvent(String),
    #[error("payload logging is disabled")]
    PayloadDisabled,
    #[error("payload logging authorization has expired")]
    PayloadExpired,
    #[error("log event is {actual} bytes, over the {limit}-byte limit")]
    EventTooLarge { actual: usize, limit: usize },
    #[error("log buffer is full of non-evictable events")]
    BufferFull,
    #[error("sequence for producer {producer} regressed from {previous} to {current}")]
    SequenceRegression {
        producer: String,
        previous: u64,
        current: u64,
    },
    #[error("canonical log encoding failed: {0}")]
    Canonical(String),
}
