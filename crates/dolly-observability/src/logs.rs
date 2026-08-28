use dolly_canonical_json::{canonicalize, deserialize_core_json, CanonicalBytes, ParseLimits};
use dolly_core_domain::{ModuleId, ModuleStorageScopeId, Timestamp};
use dolly_storage::ModuleStateProjection;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use thiserror::Error;

/// Hard ceilings keep a caller-supplied buffer finite even when it is not
/// using the default policy.
pub const MAX_LOG_EVENTS: usize = 4_096;
pub const MAX_LOG_EVENT_BYTES: usize = 64 * 1024;
pub const MAX_LOG_TOTAL_BYTES: usize = 4 * 1024 * 1024;

const LOG_SCHEMA_VERSION: u16 = 1;
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

/// The finite severity classes used by the fixed Host event catalog.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
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
            Self::Error | Self::Warn => None,
        }
    }
}

/// Fixed event meanings accepted from an admitted Host context.
///
/// This catalog deliberately has no caller-supplied text, JSON, maps, bytes,
/// premises, authority material, or external-I/O payloads.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostLogEvent {
    ModuleStarted,
    ModuleStopped,
    RequestAccepted,
    RequestRejected,
    Diagnostic,
    TraceCheckpoint,
    Error,
}

impl HostLogEvent {
    const fn event_name(self) -> &'static str {
        match self {
            Self::ModuleStarted => "module.started",
            Self::ModuleStopped => "module.stopped",
            Self::RequestAccepted => "request.accepted",
            Self::RequestRejected => "request.rejected",
            Self::Diagnostic => "diagnostic",
            Self::TraceCheckpoint => "trace.checkpoint",
            Self::Error => "error",
        }
    }

    const fn severity(self) -> LogLevel {
        match self {
            Self::ModuleStarted | Self::ModuleStopped | Self::RequestAccepted => LogLevel::Info,
            Self::RequestRejected => LogLevel::Warn,
            Self::Diagnostic => LogLevel::Debug,
            Self::TraceCheckpoint => LogLevel::Trace,
            Self::Error => LogLevel::Error,
        }
    }
}

/// A Host-owned identity for one admitted Module log stream.
///
/// The only public constructor consumes the sealed projection issued by Host
/// storage, so callers cannot relabel a Module, storage scope, or revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostLogContext {
    module_id: ModuleId,
    storage_scope_id: ModuleStorageScopeId,
    revision: u64,
}

impl HostLogContext {
    pub fn from_storage_projection(projection: &ModuleStateProjection) -> Self {
        Self {
            module_id: projection.module_id().clone(),
            storage_scope_id: projection.storage_scope_id().clone(),
            revision: projection.revision(),
        }
    }

    pub fn module_id(&self) -> &ModuleId {
        &self.module_id
    }

    pub fn storage_scope_id(&self) -> &ModuleStorageScopeId {
        &self.storage_scope_id
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    fn from_parts(
        module_id: ModuleId,
        storage_scope_id: ModuleStorageScopeId,
        revision: u64,
    ) -> Result<Self, LogError> {
        if revision == 0 || revision > MAX_SAFE_JSON_INTEGER {
            return Err(LogError::InvalidEvent(
                "log context revision must be in the safe positive integer range".to_owned(),
            ));
        }
        Ok(Self {
            module_id,
            storage_scope_id,
            revision,
        })
    }

    fn producer_key(&self) -> String {
        format!("{}@{}", self.module_id, self.storage_scope_id)
    }
}

/// One structured log object from the fixed Host event catalog.
///
/// ```compile_fail
/// use dolly_observability::StructuredLogEvent;
/// use std::collections::BTreeMap;
///
/// let mut fields = BTreeMap::new();
/// fields.insert("note".to_owned(), "g3-secret".to_owned());
/// let _event = StructuredLogEvent::new("request.finished", 1, fields);
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StructuredLogEvent {
    context: HostLogContext,
    event: HostLogEvent,
    event_time: Timestamp,
    sequence: u64,
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
    module_id: ModuleId,
    storage_scope_id: ModuleStorageScopeId,
    revision: u64,
    event: HostLogEvent,
    #[serde(default)]
    truncated: bool,
}

#[derive(Serialize)]
struct StructuredLogEventDocument<'a> {
    event_name: &'static str,
    schema_version: u16,
    severity: LogLevel,
    event_time: &'a Timestamp,
    sequence: u64,
    module_id: &'a ModuleId,
    storage_scope_id: &'a ModuleStorageScopeId,
    revision: u64,
    event: HostLogEvent,
    truncated: bool,
}

impl StructuredLogEvent {
    fn from_wire(wire: StructuredLogEventWire) -> Result<Self, LogError> {
        let context =
            HostLogContext::from_parts(wire.module_id, wire.storage_scope_id, wire.revision)?;
        let mut event = Self::new(&context, wire.event, wire.event_time, wire.sequence)?;
        if wire.event_name != event.event_name()
            || wire.schema_version != LOG_SCHEMA_VERSION
            || wire.severity != event.severity()
        {
            return Err(LogError::InvalidEvent(
                "structured log catalog metadata mismatch".to_owned(),
            ));
        }
        event.truncated = wire.truncated;
        Ok(event)
    }
    /// Construct one catalog event from exact Host storage context.
    pub fn new(
        context: &HostLogContext,
        event: HostLogEvent,
        event_time: Timestamp,
        sequence: u64,
    ) -> Result<Self, LogError> {
        if context.revision == 0 || context.revision > MAX_SAFE_JSON_INTEGER {
            return Err(LogError::InvalidEvent(
                "log context revision must be in the safe positive integer range".to_owned(),
            ));
        }
        if sequence == 0 || sequence > MAX_SAFE_JSON_INTEGER {
            return Err(LogError::InvalidEvent(
                "sequence must be in the safe positive integer range".to_owned(),
            ));
        }
        Ok(Self {
            context: context.clone(),
            event,
            event_time,
            sequence,
            truncated: false,
        })
    }

    pub fn event_name(&self) -> &'static str {
        self.event.event_name()
    }

    pub const fn schema_version(&self) -> u16 {
        LOG_SCHEMA_VERSION
    }

    pub const fn severity(&self) -> LogLevel {
        self.event.severity()
    }

    pub fn event(&self) -> HostLogEvent {
        self.event
    }

    pub fn context(&self) -> &HostLogContext {
        &self.context
    }

    pub fn event_time(&self) -> &Timestamp {
        &self.event_time
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub const fn is_truncated(&self) -> bool {
        self.truncated
    }

    pub fn canonical_bytes(&self) -> Result<CanonicalBytes, LogError> {
        let document = StructuredLogEventDocument {
            event_name: self.event_name(),
            schema_version: self.schema_version(),
            severity: self.severity(),
            event_time: &self.event_time,
            sequence: self.sequence,
            module_id: &self.context.module_id,
            storage_scope_id: &self.context.storage_scope_id,
            revision: self.context.revision,
            event: self.event,
            truncated: self.truncated,
        };
        canonicalize(&document)
            .map(|(bytes, _)| bytes)
            .map_err(|error| LogError::Canonical(error.to_string()))
    }

    /// Recover one complete canonical catalog event. Unknown event fields are
    /// rejected before any event can reach the buffer or export path.
    pub fn recover_from_bytes(input: &[u8]) -> Result<Self, LogError> {
        if input.is_empty() || input.len() > MAX_LOG_EVENT_BYTES {
            return Err(LogError::InvalidEvent(
                "log event bytes exceed the finite recovery limit".to_owned(),
            ));
        }
        let wire: StructuredLogEventWire =
            deserialize_core_json(input, ParseLimits::new(64).expect("64 is valid"))
                .map_err(|_| LogError::InvalidEvent("invalid structured log bytes".to_owned()))?;
        let event = Self::from_wire(wire)?;
        let canonical = event.canonical_bytes()?;
        if canonical.as_bytes() != input {
            return Err(LogError::InvalidEvent(
                "log event bytes are not canonical JSON".to_owned(),
            ));
        }
        Ok(event)
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
        }
    }

    pub fn limits(&self) -> LogLimits {
        self.limits
    }

    pub fn push(&mut self, event: StructuredLogEvent) -> Result<LogPushOutcome, LogError> {
        let producer = event.context.producer_key();
        if let Some(last) = self.last_sequence_by_producer.get(&producer).copied() {
            if event.sequence() <= last {
                return Err(LogError::SequenceRegression {
                    producer,
                    previous: last,
                    current: event.sequence(),
                });
            }
        }

        let bytes = event.canonical_bytes()?;
        if bytes.as_bytes().len() > self.limits.max_event_bytes() {
            return Err(LogError::EventTooLarge {
                actual: bytes.as_bytes().len(),
                limit: self.limits.max_event_bytes(),
            });
        }

        let stored = StoredLogEvent { event, bytes };
        let incoming_bytes = stored.bytes.as_bytes().len();
        while self.entries.len() >= self.limits.max_events()
            || self.total_bytes.saturating_add(incoming_bytes) > self.limits.max_total_bytes()
        {
            let Some(index) = self.oldest_evictable_index() else {
                if stored.event.severity().is_evictable() {
                    self.dropped_events = self.dropped_events.saturating_add(1);
                    self.last_sequence_by_producer
                        .insert(producer, stored.event.sequence());
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

        let truncated = stored.event.is_truncated();
        self.total_bytes = self.total_bytes.saturating_add(incoming_bytes);
        let sequence = stored.event.sequence();
        self.entries.push_back(stored);
        self.last_sequence_by_producer.insert(producer, sequence);
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

#[derive(Debug, Error, Eq, PartialEq)]
pub enum LogError {
    #[error("invalid log limits")]
    InvalidLimits,
    #[error("invalid structured log event: {0}")]
    InvalidEvent(String),
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
