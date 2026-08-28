//! Supervised local daemon process lifecycle.
//!
//! A spawned child is `Starting` until it returns an authenticated readiness
//! line for the exact non-reusable generation, WorkerEpoch, control channel,
//! ownership token, and required storage state. Only then is the generation
//! `Running` and able to issue opaque work guards. Stop revokes the current
//! identity before terminating the exact child. Restart and crash recovery
//! require fresh upstream owner authority; without it, work remains fenced.

use std::{
    collections::{BTreeMap, VecDeque},
    ffi::OsString,
    fmt,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Condvar, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

use dolly_canonical_json::Sha256Digest;
use dolly_core_domain::WorkerEpoch;
use thiserror::Error;

const READINESS_MAGIC: &str = "DOLLY_DAEMON_READY_V1";
const MAX_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_STOP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESTART_BACKOFF: Duration = Duration::from_secs(30);
const MAX_CRASH_WINDOW: Duration = Duration::from_secs(10 * 60);
const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_STOP_TIMEOUT: Duration = Duration::from_secs(1);

/// A non-zero process generation assigned before each local daemon start.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DaemonGeneration(u64);

impl DaemonGeneration {
    pub fn new(value: u64) -> Result<Self, DaemonError> {
        if value == 0 {
            return Err(DaemonError::InvalidGeneration);
        }
        Ok(Self(value))
    }

    pub fn value(self) -> u64 {
        self.0
    }
}

impl fmt::Display for DaemonGeneration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Exact upstream owner identity for one supervised daemon lifecycle.
///
/// The identity combines Extension and Module ownership, the Host connection
/// and incarnation, typed WorkerEpoch and its numeric fence, the Extension
/// generation, and the daemon control channel. Fields are private so callers
/// cannot alter an identity after it is admitted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonLifecycleIdentity {
    extension_id: String,
    module_id: String,
    extension_connection_id: String,
    incarnation_revision: i64,
    worker_epoch: WorkerEpoch,
    worker_epoch_fence: i64,
    extension_generation: i64,
    control_channel_id: String,
}

impl DaemonLifecycleIdentity {
    pub fn new(
        extension_id: impl Into<String>,
        module_id: impl Into<String>,
        extension_connection_id: impl Into<String>,
        incarnation_revision: i64,
        worker_epoch: WorkerEpoch,
        worker_epoch_fence: i64,
        extension_generation: i64,
        control_channel_id: impl Into<String>,
    ) -> Result<Self, DaemonError> {
        let extension_id = extension_id.into();
        let module_id = module_id.into();
        let extension_connection_id = extension_connection_id.into();
        let control_channel_id = control_channel_id.into();
        if extension_id.is_empty()
            || module_id.is_empty()
            || extension_connection_id.is_empty()
            || control_channel_id.is_empty()
            || extension_id.chars().any(char::is_whitespace)
            || module_id.chars().any(char::is_whitespace)
            || extension_connection_id.chars().any(char::is_whitespace)
            || control_channel_id.chars().any(char::is_whitespace)
            || incarnation_revision <= 0
            || worker_epoch_fence <= 0
            || extension_generation <= 0
        {
            return Err(DaemonError::InvalidLifecycleIdentity);
        }
        Ok(Self {
            extension_id,
            module_id,
            extension_connection_id,
            incarnation_revision,
            worker_epoch,
            worker_epoch_fence,
            extension_generation,
            control_channel_id,
        })
    }

    fn matches(
        &self,
        extension_id: &str,
        module_id: &str,
        extension_connection_id: &str,
        incarnation_revision: i64,
        worker_epoch: &WorkerEpoch,
        worker_epoch_fence: i64,
        extension_generation: i64,
    ) -> bool {
        self.extension_id == extension_id
            && self.module_id == module_id
            && self.extension_connection_id == extension_connection_id
            && self.control_channel_id == extension_connection_id
            && self.incarnation_revision == incarnation_revision
            && self.worker_epoch == *worker_epoch
            && self.worker_epoch_fence == worker_epoch_fence
            && self.extension_generation == extension_generation
    }

    fn same_owner_except_generation(&self, other: &Self) -> bool {
        self.extension_id == other.extension_id
            && self.module_id == other.module_id
            && self.extension_connection_id == other.extension_connection_id
            && self.incarnation_revision == other.incarnation_revision
            && self.worker_epoch == other.worker_epoch
            && self.worker_epoch_fence == other.worker_epoch_fence
            && self.control_channel_id == other.control_channel_id
    }
}
/// Finite restart timing and crash-loop bounds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RestartBounds {
    initial_backoff: Duration,
    max_backoff: Duration,
    crash_window: Duration,
    crash_threshold: u32,
}

impl RestartBounds {
    pub fn new(
        initial_backoff: Duration,
        max_backoff: Duration,
        crash_window: Duration,
        crash_threshold: u32,
    ) -> Result<Self, DaemonError> {
        if initial_backoff.is_zero()
            || max_backoff < initial_backoff
            || max_backoff > MAX_RESTART_BACKOFF
            || crash_window.is_zero()
            || crash_window > MAX_CRASH_WINDOW
            || crash_threshold == 0
        {
            return Err(DaemonError::InvalidReadinessBounds);
        }
        Ok(Self {
            initial_backoff,
            max_backoff,
            crash_window,
            crash_threshold,
        })
    }

    fn default_value() -> Self {
        Self {
            initial_backoff: Duration::from_millis(10),
            max_backoff: Duration::from_secs(1),
            crash_window: Duration::from_secs(10),
            crash_threshold: 3,
        }
    }
}

/// Readiness authority supplied by the parent for one daemon family.
///
/// The owner token is retained privately and is bound to each generation
/// before it is placed in the child handshake environment. Callers must
/// explicitly mark storage ready; false or unconfigured readiness cannot
/// spawn a work-eligible child.
#[derive(Clone)]
pub struct DaemonReadinessConfig {
    worker_epoch: String,
    control_channel_id: String,
    owner_token: String,
    lifecycle_identity: Option<DaemonLifecycleIdentity>,
    storage_ready: bool,
    startup_timeout: Duration,
    stop_timeout: Duration,
    restart_bounds: RestartBounds,
}

impl fmt::Debug for DaemonReadinessConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DaemonReadinessConfig")
            .field("worker_epoch", &self.worker_epoch)
            .field("control_channel_id", &self.control_channel_id)
            .field("storage_ready", &self.storage_ready)
            .field("startup_timeout", &self.startup_timeout)
            .field("stop_timeout", &self.stop_timeout)
            .field("restart_bounds", &self.restart_bounds)
            .finish()
    }
}

impl DaemonReadinessConfig {
    pub fn new(
        worker_epoch: impl Into<String>,
        control_channel_id: impl Into<String>,
        owner_token: impl Into<String>,
    ) -> Result<Self, DaemonError> {
        let config = Self {
            worker_epoch: worker_epoch.into(),
            control_channel_id: control_channel_id.into(),
            owner_token: owner_token.into(),
            lifecycle_identity: None,
            storage_ready: false,
            startup_timeout: DEFAULT_STARTUP_TIMEOUT,
            stop_timeout: DEFAULT_STOP_TIMEOUT,
            restart_bounds: RestartBounds::default_value(),
        };
        config.validate_static()?;
        Ok(config)
    }

    fn unconfigured() -> Self {
        Self {
            worker_epoch: String::new(),
            control_channel_id: String::new(),
            owner_token: String::new(),
            lifecycle_identity: None,
            storage_ready: false,
            startup_timeout: DEFAULT_STARTUP_TIMEOUT,
            stop_timeout: DEFAULT_STOP_TIMEOUT,
            restart_bounds: RestartBounds::default_value(),
        }
    }

    pub fn with_storage_ready(mut self, storage_ready: bool) -> Self {
        self.storage_ready = storage_ready;
        self
    }

    pub fn with_startup_timeout(mut self, startup_timeout: Duration) -> Self {
        self.startup_timeout = startup_timeout;
        self
    }

    pub fn with_stop_timeout(mut self, stop_timeout: Duration) -> Self {
        self.stop_timeout = stop_timeout;
        self
    }

    pub fn with_restart_bounds(mut self, restart_bounds: RestartBounds) -> Self {
        self.restart_bounds = restart_bounds;
        self
    }
    /// Attach the owner identity obtained from authenticated upstream state.
    pub fn with_lifecycle_identity(mut self, identity: DaemonLifecycleIdentity) -> Self {
        self.lifecycle_identity = Some(identity);
        self
    }

    pub fn worker_epoch(&self) -> &str {
        &self.worker_epoch
    }

    pub fn control_channel_id(&self) -> &str {
        &self.control_channel_id
    }

    pub fn storage_ready(&self) -> bool {
        self.storage_ready
    }

    pub fn startup_timeout(&self) -> Duration {
        self.startup_timeout
    }

    fn stop_timeout(&self) -> Duration {
        self.stop_timeout
    }
    fn validate(&self) -> Result<(), DaemonError> {
        self.validate_static()?;
        if !self.storage_ready {
            return Err(DaemonError::StorageNotReady);
        }
        Ok(())
    }

    fn validate_static(&self) -> Result<(), DaemonError> {
        if self.worker_epoch.is_empty()
            || self.control_channel_id.is_empty()
            || self.owner_token.is_empty()
            || self.worker_epoch.chars().any(char::is_whitespace)
            || self.control_channel_id.chars().any(char::is_whitespace)
            || self.owner_token.chars().any(char::is_whitespace)
        {
            return Err(DaemonError::ReadinessNotConfigured);
        }
        if let Some(identity) = &self.lifecycle_identity {
            if identity.worker_epoch.to_string() != self.worker_epoch
                || identity.control_channel_id != self.control_channel_id
            {
                return Err(DaemonError::LifecycleIdentityMismatch);
            }
        }
        if self.startup_timeout.is_zero() || self.startup_timeout > MAX_STARTUP_TIMEOUT {
            return Err(DaemonError::InvalidReadinessBounds);
        }
        if self.stop_timeout.is_zero() || self.stop_timeout > MAX_STOP_TIMEOUT {
            return Err(DaemonError::InvalidReadinessBounds);
        }
        Ok(())
    }

    fn owner_token_for(&self, generation: DaemonGeneration) -> String {
        Sha256Digest::compute(format!("{}:{}", self.owner_token, generation.value()).as_bytes())
            .to_canonical_string()
    }
}

/// Child process launch data. Environment values are intentionally omitted
/// from `Debug` output because launch data may contain credentials.
#[derive(Clone)]
pub struct DaemonCommand {
    program: PathBuf,
    arguments: Vec<OsString>,
    environment: BTreeMap<OsString, OsString>,
}

impl DaemonCommand {
    pub fn new(program: impl Into<PathBuf>) -> Result<Self, DaemonError> {
        let program = program.into();
        if program.as_os_str().is_empty() {
            return Err(DaemonError::InvalidCommand);
        }
        Ok(Self {
            program,
            arguments: Vec::new(),
            environment: BTreeMap::new(),
        })
    }

    pub fn arg(mut self, argument: impl Into<OsString>) -> Self {
        self.arguments.push(argument.into());
        self
    }

    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.environment.insert(key.into(), value.into());
        self
    }

    pub fn program(&self) -> &std::path::Path {
        &self.program
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    pub fn environment_keys(&self) -> impl Iterator<Item = &OsString> {
        self.environment.keys()
    }
}

impl fmt::Debug for DaemonCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DaemonCommand")
            .field("program", &self.program)
            .field("argument_count", &self.arguments.len())
            .field("environment_key_count", &self.environment.len())
            .finish()
    }
}

/// Whether an unexpected child exit is eligible for fresh-authority recovery.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestartPolicy {
    Never,
    OnUnexpectedExit,
}

/// Observable supervisor state. Only `Running` is work-eligible.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DaemonState {
    Stopped,
    Starting(DaemonGeneration),
    Running(DaemonGeneration),
    Exited(DaemonGeneration),
    AwaitingAuthority(DaemonGeneration),
    Quarantined(DaemonGeneration),
}

/// Fail-closed lifecycle errors. No command arguments, environment values,
/// owner tokens, or handshake contents are included in an error message.
#[derive(Debug, Error)]
pub enum DaemonError {
    #[error("daemon command is empty")]
    InvalidCommand,
    #[error("daemon generation must be non-zero")]
    InvalidGeneration,
    #[error("daemon generation exhausted")]
    GenerationExhausted,
    #[error("daemon process is already running at generation {0}")]
    AlreadyRunning(DaemonGeneration),
    #[error("daemon process operation failed")]
    Process(#[source] std::io::Error),
    #[error("daemon is not running")]
    NotRunning,
    #[error("daemon needs a fresh lifecycle identity before restart")]
    FreshLifecycleIdentityRequired,
    #[error("daemon lifecycle identity was reused")]
    LifecycleIdentityReused,
    #[error("daemon lifecycle identity generation is not the next generation")]
    NonMonotonicLifecycleIdentity,
    #[error("daemon generation is stale")]
    StaleGeneration {
        expected: DaemonGeneration,
        actual: Option<DaemonGeneration>,
    },
    #[error("daemon readiness is not configured")]
    ReadinessNotConfigured,
    #[error("daemon storage is not ready")]
    StorageNotReady,
    #[error("daemon readiness deadline elapsed")]
    ReadinessTimeout,
    #[error("daemon readiness handshake is unavailable")]
    ReadinessUnavailable,
    #[error("daemon readiness handshake does not match the exact child")]
    ReadinessMismatch,
    #[error("daemon readiness bounds are invalid")]
    InvalidReadinessBounds,
    #[error("daemon lifecycle identity does not match readiness authority")]
    LifecycleIdentityMismatch,
    #[error("daemon lifecycle identity is invalid")]
    InvalidLifecycleIdentity,
    #[error("daemon crash loop is quarantined at generation {0}")]
    CrashLoopQuarantined(DaemonGeneration),
    #[error("daemon work is not admitted")]
    WorkNotAdmissible,
    #[error("daemon work was cancelled")]
    WorkCancelled,
    #[error("daemon could not drain in-flight work before its deadline")]
    DrainDeadlineExceeded,
    #[error("daemon work guard is stale")]
    StaleWorkGuard,
}

struct LifecycleStatus {
    admission_open: bool,
    cancelled: bool,
    active_guards: BTreeMap<u64, ()>,
    active_in_flight: usize,
    next_guard_id: u64,
}

struct LifecycleInner {
    generation: DaemonGeneration,
    identity: Option<DaemonLifecycleIdentity>,
    status: Mutex<LifecycleStatus>,
    drained: Condvar,
}

impl LifecycleInner {
    fn new(generation: DaemonGeneration, identity: Option<DaemonLifecycleIdentity>) -> Self {
        Self {
            generation,
            identity,
            status: Mutex::new(LifecycleStatus {
                admission_open: false,
                cancelled: true,
                active_guards: BTreeMap::new(),
                active_in_flight: 0,
                next_guard_id: 1,
            }),
            drained: Condvar::new(),
        }
    }
}

/// Opaque shared state for one authenticated daemon generation.
#[derive(Clone)]
pub struct DaemonLifecycleToken {
    inner: Arc<LifecycleInner>,
    guard_id: u64,
}

impl fmt::Debug for DaemonLifecycleToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DaemonLifecycleToken")
            .field("generation", &self.inner.generation)
            .finish()
    }
}

impl DaemonLifecycleToken {
    fn new(generation: DaemonGeneration, identity: Option<DaemonLifecycleIdentity>) -> Self {
        Self {
            inner: Arc::new(LifecycleInner::new(generation, identity)),
            guard_id: 0,
        }
    }
    pub fn generation(&self) -> DaemonGeneration {
        self.inner.generation
    }

    /// Verify every upstream owner field against this exact lifecycle.
    pub fn matches_owner(
        &self,
        extension_id: &str,
        module_id: &str,
        extension_connection_id: &str,
        incarnation_revision: i64,
        worker_epoch: &WorkerEpoch,
        worker_epoch_fence: i64,
        extension_generation: i64,
    ) -> bool {
        u64::try_from(extension_generation).ok() == Some(self.generation().value())
            && self.inner.identity.as_ref().is_some_and(|identity| {
                identity.matches(
                    extension_id,
                    module_id,
                    extension_connection_id,
                    incarnation_revision,
                    worker_epoch,
                    worker_epoch_fence,
                    extension_generation,
                )
            })
    }

    pub fn check(&self) -> Result<(), DaemonError> {
        let status = self
            .inner
            .status
            .lock()
            .map_err(|_| DaemonError::StaleWorkGuard)?;
        if status.cancelled {
            Err(DaemonError::WorkCancelled)
        } else if status.admission_open && status.active_guards.contains_key(&self.guard_id) {
            Ok(())
        } else {
            Err(DaemonError::StaleWorkGuard)
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner
            .status
            .lock()
            .map(|status| status.cancelled)
            .unwrap_or(true)
    }

    pub fn begin_in_flight(&self) -> Result<InFlightWork, DaemonError> {
        let mut status = self
            .inner
            .status
            .lock()
            .map_err(|_| DaemonError::StaleWorkGuard)?;
        if status.cancelled {
            return Err(DaemonError::WorkCancelled);
        }
        if !status.admission_open || !status.active_guards.contains_key(&self.guard_id) {
            return Err(DaemonError::StaleWorkGuard);
        }
        status.active_in_flight = status
            .active_in_flight
            .checked_add(1)
            .ok_or(DaemonError::GenerationExhausted)?;
        Ok(InFlightWork {
            lifecycle: self.clone(),
        })
    }

    fn open(&self) {
        if let Ok(mut status) = self.inner.status.lock() {
            status.admission_open = true;
            status.cancelled = false;
        }
    }

    fn issue_guard(&self) -> Result<DaemonWorkGuard, DaemonError> {
        let mut status = self
            .inner
            .status
            .lock()
            .map_err(|_| DaemonError::WorkNotAdmissible)?;
        if status.cancelled || !status.admission_open {
            return Err(DaemonError::WorkNotAdmissible);
        }
        let guard_id = status.next_guard_id;
        status.next_guard_id = guard_id
            .checked_add(1)
            .ok_or(DaemonError::GenerationExhausted)?;
        status.active_guards.insert(guard_id, ());
        Ok(DaemonWorkGuard {
            lifecycle: DaemonLifecycleToken {
                inner: Arc::clone(&self.inner),
                guard_id,
            },
        })
    }

    fn active_guard_count(&self) -> usize {
        self.inner
            .status
            .lock()
            .map(|status| status.active_guards.len())
            .unwrap_or(0)
    }

    fn active_in_flight_count(&self) -> usize {
        self.inner
            .status
            .lock()
            .map(|status| status.active_in_flight)
            .unwrap_or(0)
    }

    fn revoke_and_drain(&self, timeout: Duration) -> Result<(), DaemonError> {
        let deadline = Instant::now() + timeout;
        let mut status = self
            .inner
            .status
            .lock()
            .map_err(|_| DaemonError::DrainDeadlineExceeded)?;
        status.admission_open = false;
        status.cancelled = true;
        status.active_guards.clear();
        while status.active_in_flight != 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(DaemonError::DrainDeadlineExceeded);
            }
            let (next_status, wait) = self
                .inner
                .drained
                .wait_timeout(status, remaining)
                .map_err(|_| DaemonError::DrainDeadlineExceeded)?;
            status = next_status;
            if wait.timed_out() && status.active_in_flight != 0 {
                return Err(DaemonError::DrainDeadlineExceeded);
            }
        }
        Ok(())
    }

    fn remove_guard(&self, guard_id: u64) {
        if let Ok(mut status) = self.inner.status.lock() {
            status.active_guards.remove(&guard_id);
        }
    }
}

/// Tracked in-flight work scope. Dropping it decrements the shared drain count.
pub struct InFlightWork {
    lifecycle: DaemonLifecycleToken,
}

impl fmt::Debug for InFlightWork {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InFlightWork")
            .field("generation", &self.lifecycle.generation())
            .finish()
    }
}

impl InFlightWork {
    pub fn check(&self) -> Result<(), DaemonError> {
        self.lifecycle.check()
    }

    pub fn is_cancelled(&self) -> bool {
        self.lifecycle.is_cancelled()
    }

    pub fn lifecycle(&self) -> DaemonLifecycleToken {
        self.lifecycle.clone()
    }
}

impl Drop for InFlightWork {
    fn drop(&mut self) {
        if let Ok(mut status) = self.lifecycle.inner.status.lock() {
            status.active_in_flight = status.active_in_flight.saturating_sub(1);
            self.lifecycle.inner.drained.notify_all();
        }
    }
}

/// Opaque work permission bound to one authenticated daemon generation.
pub struct DaemonWorkGuard {
    lifecycle: DaemonLifecycleToken,
}

impl fmt::Debug for DaemonWorkGuard {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DaemonWorkGuard")
            .field("generation", &self.lifecycle.generation())
            .finish()
    }
}

impl DaemonWorkGuard {
    pub fn generation(&self) -> DaemonGeneration {
        self.lifecycle.generation()
    }

    pub fn check(&self) -> Result<(), DaemonError> {
        self.lifecycle.check()
    }

    pub fn is_usable(&self) -> bool {
        self.check().is_ok()
    }

    pub fn lifecycle_token(&self) -> Result<DaemonLifecycleToken, DaemonError> {
        self.check()?;
        Ok(self.lifecycle.clone())
    }

    pub fn begin_in_flight(&self) -> Result<InFlightWork, DaemonError> {
        self.lifecycle.begin_in_flight()
    }
}

impl Drop for DaemonWorkGuard {
    fn drop(&mut self) {
        self.lifecycle.remove_guard(self.lifecycle.guard_id);
    }
}

/// Owns one local daemon child and its non-reusable process generations.
pub struct LocalDaemonSupervisor {
    command: DaemonCommand,
    readiness: DaemonReadinessConfig,
    restart_policy: RestartPolicy,
    initial_generation: DaemonGeneration,
    child: Option<Child>,
    generation: Option<DaemonGeneration>,
    state: DaemonState,
    last_exit_status: Option<ExitStatus>,
    stop_requested: bool,
    awaiting_authority: bool,
    lifecycle: Option<DaemonLifecycleToken>,
    failure_times: VecDeque<Instant>,
    last_failure: Option<(Instant, Duration)>,
    next_backoff: Duration,
    quarantined: bool,
}

impl LocalDaemonSupervisor {
    /// Create a supervisor whose caller must configure readiness before start.
    pub fn new(command: DaemonCommand) -> Self {
        Self::with_config(
            command,
            RestartPolicy::OnUnexpectedExit,
            DaemonReadinessConfig::unconfigured(),
        )
    }

    pub fn with_restart_policy(command: DaemonCommand, restart_policy: RestartPolicy) -> Self {
        Self::with_config(
            command,
            restart_policy,
            DaemonReadinessConfig::unconfigured(),
        )
    }

    pub fn with_readiness(command: DaemonCommand, readiness: DaemonReadinessConfig) -> Self {
        Self::with_config(command, RestartPolicy::OnUnexpectedExit, readiness)
    }

    pub fn with_readiness_at_generation(
        command: DaemonCommand,
        readiness: DaemonReadinessConfig,
        initial_generation: DaemonGeneration,
    ) -> Self {
        Self::with_config_at_generation(
            command,
            RestartPolicy::OnUnexpectedExit,
            readiness,
            initial_generation,
        )
    }

    pub fn with_config(
        command: DaemonCommand,
        restart_policy: RestartPolicy,
        readiness: DaemonReadinessConfig,
    ) -> Self {
        Self::with_config_at_generation(
            command,
            restart_policy,
            readiness,
            DaemonGeneration::new(1).expect("constant generation"),
        )
    }

    fn with_config_at_generation(
        command: DaemonCommand,
        restart_policy: RestartPolicy,
        readiness: DaemonReadinessConfig,
        initial_generation: DaemonGeneration,
    ) -> Self {
        let next_backoff = readiness.restart_bounds.initial_backoff;
        Self {
            command,
            readiness,
            restart_policy,
            initial_generation,
            state: DaemonState::Stopped,
            child: None,
            generation: None,
            last_exit_status: None,
            stop_requested: false,
            awaiting_authority: false,
            lifecycle: None,
            failure_times: VecDeque::new(),
            last_failure: None,
            next_backoff,
            quarantined: false,
        }
    }

    pub fn state(&self) -> DaemonState {
        self.state
    }

    pub fn generation(&self) -> Option<DaemonGeneration> {
        self.generation
    }

    pub fn last_exit_status(&self) -> Option<ExitStatus> {
        self.last_exit_status
    }

    pub fn restart_policy(&self) -> RestartPolicy {
        self.restart_policy
    }

    pub fn readiness(&self) -> &DaemonReadinessConfig {
        &self.readiness
    }

    pub fn active_work_count(&self) -> usize {
        self.lifecycle
            .as_ref()
            .map(DaemonLifecycleToken::active_guard_count)
            .unwrap_or(0)
    }

    pub fn active_in_flight_count(&self) -> usize {
        self.lifecycle
            .as_ref()
            .map(DaemonLifecycleToken::active_in_flight_count)
            .unwrap_or(0)
    }

    /// Start the child. It remains `Starting` internally until readiness passes.
    pub fn start(&mut self) -> Result<DaemonGeneration, DaemonError> {
        self.reap_exited_child()?;
        if self.quarantined {
            return Err(DaemonError::CrashLoopQuarantined(
                self.generation.expect("quarantine has a generation"),
            ));
        }
        if let Some(generation) = self.live_generation() {
            return Err(DaemonError::AlreadyRunning(generation));
        }
        if let DaemonState::Starting(generation) = self.state {
            return Err(DaemonError::AlreadyRunning(generation));
        }
        if self.awaiting_authority {
            return Err(DaemonError::FreshLifecycleIdentityRequired);
        }
        self.stop_requested = false;
        self.wait_for_backoff();
        self.spawn_next()
    }

    /// Close admission, cancel and drain work, then terminate the exact child.
    pub fn stop(&mut self) -> Result<(), DaemonError> {
        self.stop_requested = true;
        let drain_result = self.close_current_lifecycle();
        let child_result = self
            .child
            .take()
            .map(|mut child| self.terminate_child(&mut child));

        if let Err(error) = drain_result {
            self.awaiting_authority = self.generation.is_some();
            self.quarantined = true;
            self.state =
                DaemonState::Quarantined(self.generation.unwrap_or(self.initial_generation));
            return Err(error);
        }
        let Some(child_result) = child_result else {
            self.awaiting_authority = self.generation.is_some();
            if self.quarantined {
                self.state =
                    DaemonState::Quarantined(self.generation.unwrap_or(self.initial_generation));
                return Ok(());
            }
            self.state = DaemonState::Stopped;
            return Ok(());
        };
        match child_result {
            Ok(status) => {
                self.last_exit_status = Some(status);
                self.awaiting_authority = self.generation.is_some();
                if self.quarantined {
                    self.state = DaemonState::Quarantined(
                        self.generation.unwrap_or(self.initial_generation),
                    );
                    return Err(DaemonError::CrashLoopQuarantined(
                        self.generation.unwrap_or(self.initial_generation),
                    ));
                }
                self.state = DaemonState::Stopped;
                Ok(())
            }
            Err(error) => {
                self.awaiting_authority = self.generation.is_some();
                self.state =
                    DaemonState::Exited(self.generation.unwrap_or(self.initial_generation));
                Err(error)
            }
        }
    }

    /// A restart requires a fresh upstream lifecycle identity.
    pub fn restart(&mut self) -> Result<DaemonGeneration, DaemonError> {
        Err(DaemonError::FreshLifecycleIdentityRequired)
    }

    /// Replace the current owner with the next accepted upstream generation.
    pub fn restart_with_identity(
        &mut self,
        identity: DaemonLifecycleIdentity,
    ) -> Result<DaemonGeneration, DaemonError> {
        let current_generation = self.generation.ok_or(DaemonError::NotRunning)?;
        let current_identity = self
            .readiness
            .lifecycle_identity
            .as_ref()
            .ok_or(DaemonError::FreshLifecycleIdentityRequired)?;
        if self.quarantined {
            return Err(DaemonError::CrashLoopQuarantined(current_generation));
        }
        if identity == *current_identity {
            return Err(DaemonError::LifecycleIdentityReused);
        }
        if !identity.same_owner_except_generation(current_identity) {
            return Err(DaemonError::LifecycleIdentityMismatch);
        }
        let expected_generation = current_generation
            .value()
            .checked_add(1)
            .ok_or(DaemonError::GenerationExhausted)?;
        let expected_extension_generation = current_identity
            .extension_generation
            .checked_add(1)
            .ok_or(DaemonError::GenerationExhausted)?;
        if identity.extension_generation != expected_extension_generation
            || u64::try_from(identity.extension_generation).ok() != Some(expected_generation)
            || identity.worker_epoch.to_string() != self.readiness.worker_epoch
            || identity.control_channel_id != self.readiness.control_channel_id
        {
            return Err(DaemonError::NonMonotonicLifecycleIdentity);
        }
        self.stop()?;
        self.readiness.lifecycle_identity = Some(identity);
        self.awaiting_authority = false;
        self.start()
    }

    /// Explicit operator action required to leave crash-loop quarantine.
    pub fn clear_quarantine(&mut self) -> Result<(), DaemonError> {
        if self.child.is_some() || self.active_in_flight_count() != 0 {
            return Err(DaemonError::AlreadyRunning(
                self.generation.unwrap_or(self.initial_generation),
            ));
        }
        self.quarantined = false;
        self.failure_times.clear();
        self.last_failure = None;
        self.next_backoff = self.readiness.restart_bounds.initial_backoff;
        self.lifecycle = None;
        self.awaiting_authority = self.generation.is_some();
        self.state = DaemonState::Stopped;
        Ok(())
    }
    /// Observe the child; unexpected exits fence work and await fresh authority.
    pub fn poll(&mut self) -> Result<DaemonState, DaemonError> {
        let status = match self.child.as_mut() {
            Some(child) => child.try_wait().map_err(DaemonError::Process)?,
            None => return Ok(self.state),
        };
        let Some(status) = status else {
            return Ok(self.state);
        };

        self.child.take();
        self.last_exit_status = Some(status);
        let exited_generation = self.generation.ok_or(DaemonError::NotRunning)?;
        if let Err(error) = self.close_current_lifecycle() {
            self.awaiting_authority = true;
            self.quarantined = true;
            self.state = DaemonState::Quarantined(exited_generation);
            return Err(error);
        }
        self.record_failure(exited_generation);
        if !self.quarantined {
            self.state = DaemonState::AwaitingAuthority(exited_generation);
        }
        Ok(self.state)
    }

    /// Require work to belong to the currently ready child generation.
    pub fn require_current_generation(
        &mut self,
        expected: DaemonGeneration,
    ) -> Result<(), DaemonError> {
        let _ = self.poll()?;
        match self.state {
            DaemonState::Running(actual) if actual == expected => Ok(()),
            DaemonState::Running(actual) => Err(DaemonError::StaleGeneration {
                expected,
                actual: Some(actual),
            }),
            DaemonState::Starting(actual) => Err(DaemonError::StaleGeneration {
                expected,
                actual: Some(actual),
            }),
            DaemonState::Stopped
            | DaemonState::Exited(_)
            | DaemonState::AwaitingAuthority(_)
            | DaemonState::Quarantined(_) => Err(DaemonError::StaleGeneration {
                expected,
                actual: self.generation,
            }),
        }
    }

    /// Issue an opaque guard only after authenticated readiness is live.
    pub fn acquire_work_guard(
        &mut self,
        expected: DaemonGeneration,
    ) -> Result<DaemonWorkGuard, DaemonError> {
        self.require_current_generation(expected)?;
        self.lifecycle
            .as_ref()
            .ok_or(DaemonError::WorkNotAdmissible)?
            .issue_guard()
    }

    pub fn require_work_guard(&mut self, guard: &DaemonWorkGuard) -> Result<(), DaemonError> {
        guard.check()?;
        self.require_current_generation(guard.generation())?;
        guard.check()
    }

    /// Begin one tracked operation under a ready generation guard.
    pub fn begin_work(&mut self, guard: &DaemonWorkGuard) -> Result<InFlightWork, DaemonError> {
        self.require_work_guard(guard)?;
        guard.begin_in_flight()
    }

    fn live_generation(&self) -> Option<DaemonGeneration> {
        match self.state {
            DaemonState::Running(generation) if self.child.is_some() => Some(generation),
            _ => None,
        }
    }

    fn reap_exited_child(&mut self) -> Result<(), DaemonError> {
        let status = match self.child.as_mut() {
            Some(child) => child.try_wait().map_err(DaemonError::Process)?,
            None => return Ok(()),
        };
        let Some(status) = status else {
            return Ok(());
        };
        self.child.take();
        self.last_exit_status = Some(status);
        let generation = self.generation.ok_or(DaemonError::NotRunning)?;
        if let Err(error) = self.close_current_lifecycle() {
            self.awaiting_authority = true;
            self.quarantined = true;
            self.state = DaemonState::Quarantined(generation);
            return Err(error);
        }
        self.record_failure(generation);
        if !self.quarantined {
            self.state = DaemonState::AwaitingAuthority(generation);
        }
        Ok(())
    }

    fn spawn_next(&mut self) -> Result<DaemonGeneration, DaemonError> {
        if self.quarantined {
            return Err(DaemonError::CrashLoopQuarantined(
                self.generation.expect("quarantine has a generation"),
            ));
        }
        self.readiness.validate()?;
        self.close_current_lifecycle()?;
        let next_value = self
            .generation
            .map(|generation| {
                generation
                    .value()
                    .checked_add(1)
                    .ok_or(DaemonError::GenerationExhausted)
            })
            .unwrap_or(Ok(self.initial_generation.value()))?;
        let generation = DaemonGeneration::new(next_value)?;
        let identity = match (
            self.generation.is_some(),
            self.readiness.lifecycle_identity.as_ref(),
        ) {
            (true, None) => return Err(DaemonError::FreshLifecycleIdentityRequired),
            (_, Some(identity))
                if u64::try_from(identity.extension_generation).ok()
                    != Some(generation.value()) =>
            {
                return Err(DaemonError::LifecycleIdentityMismatch);
            }
            (_, identity) => identity.cloned(),
        };
        self.generation = Some(generation);
        self.lifecycle = Some(DaemonLifecycleToken::new(generation, identity));
        self.state = DaemonState::Starting(generation);

        let mut command = Command::new(&self.command.program);
        command.args(&self.command.arguments);
        command.envs(&self.command.environment);
        command
            .env("DOLLY_DAEMON_GENERATION", generation.value().to_string())
            .env("DOLLY_DAEMON_WORKER_EPOCH", &self.readiness.worker_epoch)
            .env(
                "DOLLY_DAEMON_CONTROL_CHANNEL_ID",
                &self.readiness.control_channel_id,
            )
            .env(
                "DOLLY_DAEMON_OWNER_TOKEN",
                self.readiness.owner_token_for(generation),
            )
            .env(
                "DOLLY_DAEMON_STORAGE_READY",
                if self.readiness.storage_ready {
                    "1"
                } else {
                    "0"
                },
            )
            .stdout(Stdio::piped())
            .stdin(Stdio::null());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let _ = self.close_current_lifecycle();
                self.record_failure(generation);
                if !self.quarantined {
                    self.state = DaemonState::AwaitingAuthority(generation);
                }
                return Err(DaemonError::Process(error));
            }
        };

        match self.await_readiness(&mut child, generation) {
            Ok(()) => {
                self.child = Some(child);
                self.state = DaemonState::Running(generation);
                self.open_admission(generation);
                self.awaiting_authority = false;
                self.last_failure = None;
                self.next_backoff = self.readiness.restart_bounds.initial_backoff;
                Ok(generation)
            }
            Err(error) => {
                if let Ok(status) = self.terminate_child(&mut child) {
                    self.last_exit_status = Some(status);
                }
                let _ = self.close_current_lifecycle();
                self.record_failure(generation);
                if !self.quarantined {
                    self.state = DaemonState::AwaitingAuthority(generation);
                }
                Err(error)
            }
        }
    }

    fn await_readiness(
        &self,
        child: &mut Child,
        expected_generation: DaemonGeneration,
    ) -> Result<(), DaemonError> {
        let stdout = child
            .stdout
            .take()
            .ok_or(DaemonError::ReadinessUnavailable)?;
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout)
                .read_line(&mut line)
                .map(|bytes| (bytes, line));
            let _ = sender.send(result);
        });
        match receiver.recv_timeout(self.readiness.startup_timeout) {
            Ok(Ok((0, _))) => Err(DaemonError::ReadinessUnavailable),
            Ok(Ok((_, line))) => {
                let handshake = parse_readiness(&line)?;
                if handshake.generation != expected_generation
                    || handshake.worker_epoch != self.readiness.worker_epoch
                    || handshake.control_channel_id != self.readiness.control_channel_id
                    || handshake.owner_token != self.readiness.owner_token_for(expected_generation)
                    || handshake.storage_ready != self.readiness.storage_ready
                    || !handshake.storage_ready
                {
                    return Err(DaemonError::ReadinessMismatch);
                }
                Ok(())
            }
            Ok(Err(_)) => Err(DaemonError::ReadinessUnavailable),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(DaemonError::ReadinessTimeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(DaemonError::ReadinessUnavailable),
        }
    }

    fn terminate_child(&self, child: &mut Child) -> Result<ExitStatus, DaemonError> {
        let deadline = Instant::now() + self.readiness.stop_timeout();
        loop {
            if let Some(status) = child.try_wait().map_err(DaemonError::Process)? {
                return Ok(status);
            }
            if Instant::now() >= deadline {
                child.kill().map_err(DaemonError::Process)?;
                return child.wait().map_err(DaemonError::Process);
            }
            thread::sleep(Duration::from_millis(2));
        }
    }

    fn record_failure(&mut self, generation: DaemonGeneration) {
        let now = Instant::now();
        let window = self.readiness.restart_bounds.crash_window;
        while self
            .failure_times
            .front()
            .is_some_and(|failure| now.duration_since(*failure) > window)
        {
            self.failure_times.pop_front();
        }
        self.awaiting_authority = true;
        self.failure_times.push_back(now);
        let delay = self.next_backoff;
        self.last_failure = Some((now, delay));
        self.next_backoff = self
            .next_backoff
            .checked_mul(2)
            .map(|value| value.min(self.readiness.restart_bounds.max_backoff))
            .unwrap_or(self.readiness.restart_bounds.max_backoff);
        if self.failure_times.len() >= self.readiness.restart_bounds.crash_threshold as usize {
            self.quarantined = true;
            let _ = self.close_current_lifecycle();
            self.state = DaemonState::Quarantined(generation);
        }
    }

    fn wait_for_backoff(&self) {
        let Some((failed_at, delay)) = self.last_failure else {
            return;
        };
        let remaining = delay.saturating_sub(failed_at.elapsed());
        if !remaining.is_zero() {
            thread::sleep(remaining);
        }
    }

    fn close_current_lifecycle(&mut self) -> Result<(), DaemonError> {
        let Some(lifecycle) = self.lifecycle.as_ref() else {
            return Ok(());
        };
        lifecycle.revoke_and_drain(self.readiness.stop_timeout())?;
        self.lifecycle = None;
        Ok(())
    }

    fn open_admission(&self, generation: DaemonGeneration) {
        if self
            .lifecycle
            .as_ref()
            .is_some_and(|lifecycle| lifecycle.generation() == generation)
        {
            if let Some(lifecycle) = &self.lifecycle {
                lifecycle.open();
            }
        }
    }
}
impl Drop for LocalDaemonSupervisor {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

struct ReadinessHandshake {
    generation: DaemonGeneration,
    worker_epoch: String,
    control_channel_id: String,
    owner_token: String,
    storage_ready: bool,
}

fn parse_readiness(line: &str) -> Result<ReadinessHandshake, DaemonError> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() != 6 || fields[0] != READINESS_MAGIC {
        return Err(DaemonError::ReadinessMismatch);
    }
    let generation = fields[1]
        .parse::<u64>()
        .ok()
        .and_then(|value| DaemonGeneration::new(value).ok())
        .ok_or(DaemonError::ReadinessMismatch)?;
    let storage_ready = match fields[5] {
        "0" => false,
        "1" => true,
        _ => return Err(DaemonError::ReadinessMismatch),
    };
    Ok(ReadinessHandshake {
        generation,
        worker_epoch: fields[2].into(),
        control_channel_id: fields[3].into(),
        owner_token: fields[4].into(),
        storage_ready,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const CHILD_SCRIPT: &str = r#"
mode="$DOLLY_DAEMON_READY_MODE"
if [ "$mode" = ready ] || [ "$mode" = ready-exit ] || [ "$mode" = stale ] || [ "$mode" = wrong-worker ] || [ "$mode" = wrong-channel ] || [ "$mode" = wrong-owner ] || [ "$mode" = storage-not-ready ]; then
  generation="$DOLLY_DAEMON_GENERATION"
  worker="$DOLLY_DAEMON_WORKER_EPOCH"
  channel="$DOLLY_DAEMON_CONTROL_CHANNEL_ID"
  owner="$DOLLY_DAEMON_OWNER_TOKEN"
  storage="$DOLLY_DAEMON_STORAGE_READY"
  if [ "$mode" = stale ]; then generation=$((generation - 1)); fi
  if [ "$mode" = wrong-worker ]; then worker=wrong-worker; fi
  if [ "$mode" = wrong-channel ]; then channel=wrong-channel; fi
  if [ "$mode" = wrong-owner ]; then owner=wrong-owner; fi
  if [ "$mode" = storage-not-ready ]; then storage=0; fi
  printf 'DOLLY_DAEMON_READY_V1 %s %s %s %s %s\n' "$generation" "$worker" "$channel" "$owner" "$storage"
fi
if [ "$mode" = ready-exit ]; then exit 0; fi
sleep 2
"#;

    fn command(mode: &str) -> DaemonCommand {
        DaemonCommand::new("sh")
            .expect("command")
            .arg("-c")
            .arg(CHILD_SCRIPT)
            .env("DOLLY_DAEMON_READY_MODE", mode)
    }

    fn readiness() -> DaemonReadinessConfig {
        let worker_epoch: WorkerEpoch = "0198ab31-6c44-7e8a-b2bb-000000000110"
            .parse()
            .expect("worker epoch");
        let identity = DaemonLifecycleIdentity::new(
            "org.example.extension",
            "module-one",
            "control-channel-1",
            1,
            worker_epoch.clone(),
            17,
            1,
            "control-channel-1",
        )
        .expect("lifecycle identity");
        DaemonReadinessConfig::new(
            worker_epoch.to_string(),
            "control-channel-1",
            "owner-secret",
        )
        .expect("readiness")
        .with_lifecycle_identity(identity)
        .with_storage_ready(true)
        .with_startup_timeout(Duration::from_millis(80))
        .with_stop_timeout(Duration::from_millis(80))
        .with_restart_bounds(
            RestartBounds::new(
                Duration::from_millis(1),
                Duration::from_millis(8),
                Duration::from_secs(1),
                3,
            )
            .expect("restart bounds"),
        )
    }

    fn supervisor(mode: &str) -> LocalDaemonSupervisor {
        LocalDaemonSupervisor::with_readiness(command(mode), readiness())
    }

    #[test]
    fn unconfigured_supervisor_never_marks_spawned_child_running() {
        let mut supervisor = LocalDaemonSupervisor::new(command("ready"));
        assert!(matches!(
            supervisor.start(),
            Err(DaemonError::ReadinessNotConfigured)
        ));
        assert_eq!(supervisor.state(), DaemonState::Stopped);
        assert_eq!(supervisor.active_work_count(), 0);
    }

    #[test]
    fn unauthenticated_child_fails_closed_at_startup_deadline() {
        let mut supervisor = supervisor("silent");
        assert!(matches!(
            supervisor.start(),
            Err(DaemonError::ReadinessTimeout)
        ));
        assert!(matches!(
            supervisor.state(),
            DaemonState::Exited(_)
                | DaemonState::AwaitingAuthority(_)
                | DaemonState::Quarantined(_)
        ));
        assert_eq!(supervisor.active_work_count(), 0);
        supervisor.stop().expect("stop failed child");
    }

    #[test]
    fn stale_and_cross_generation_handshakes_are_rejected() {
        for mode in [
            "stale",
            "wrong-worker",
            "wrong-channel",
            "wrong-owner",
            "storage-not-ready",
        ] {
            let mut supervisor = supervisor(mode);
            assert!(
                matches!(supervisor.start(), Err(DaemonError::ReadinessMismatch)),
                "mode {mode} must fail closed"
            );
            supervisor.stop().expect("stop rejected child");
        }
    }

    #[test]
    fn storage_must_be_ready_before_spawn() {
        let readiness = DaemonReadinessConfig::new("worker-epoch-1", "control-channel-1", "owner")
            .expect("readiness");
        let mut supervisor = LocalDaemonSupervisor::with_readiness(command("ready"), readiness);
        assert!(matches!(
            supervisor.start(),
            Err(DaemonError::StorageNotReady)
        ));
        assert_eq!(supervisor.state(), DaemonState::Stopped);
        assert_eq!(supervisor.generation(), None);
    }

    #[test]
    fn authenticated_readiness_issues_generation_bound_work_guard() {
        let mut supervisor = supervisor("ready");
        let generation = supervisor.start().expect("authenticated readiness");
        assert_eq!(supervisor.state(), DaemonState::Running(generation));
        let guard = supervisor
            .acquire_work_guard(generation)
            .expect("work guard");
        assert!(guard.is_usable());
        assert_eq!(supervisor.active_work_count(), 1);
        let mut work_calls = 0;
        {
            let _work = supervisor
                .begin_work(&guard)
                .expect("guarded work must be tracked");
            work_calls += 1;
        }
        assert_eq!(work_calls, 1);
        assert_eq!(supervisor.active_in_flight_count(), 0);
        supervisor.stop().expect("stop");
        assert!(!guard.is_usable());
        assert!(matches!(
            supervisor.require_work_guard(&guard),
            Err(DaemonError::StaleWorkGuard) | Err(DaemonError::WorkCancelled)
        ));
        assert_eq!(supervisor.active_work_count(), 0);
        assert_eq!(supervisor.active_in_flight_count(), 0);
    }

    #[test]
    fn stop_cancels_and_waits_for_tracked_work_before_terminating_child() {
        let mut supervisor = supervisor("ready");
        let generation = supervisor.start().expect("authenticated readiness");
        let guard = supervisor
            .acquire_work_guard(generation)
            .expect("work guard");
        let in_flight = supervisor.begin_work(&guard).expect("tracked work");
        let (cancelled_sender, cancelled_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let worker = thread::spawn(move || {
            while !in_flight.is_cancelled() {
                thread::yield_now();
            }
            cancelled_sender
                .send(())
                .expect("cancellation notification");
            release_receiver.recv().expect("drain release");
            assert!(in_flight.is_cancelled());
        });

        let (finished_sender, finished_receiver) = mpsc::channel();
        let stopper = thread::spawn(move || {
            let result = supervisor.stop();
            finished_sender.send(result).expect("stop result");
            supervisor
        });
        cancelled_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("stop must cancel tracked work");
        assert!(matches!(
            finished_receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        release_sender.send(()).expect("release tracked work");
        worker.join().expect("tracked work thread");
        assert!(
            finished_receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("stop completion")
                .is_ok()
        );
        let supervisor = stopper.join().expect("stopper thread");
        assert_eq!(supervisor.state(), DaemonState::Stopped);
        assert_eq!(supervisor.active_work_count(), 0);
        assert_eq!(supervisor.active_in_flight_count(), 0);
        assert!(!guard.is_usable());
    }

    #[test]
    fn stop_deadline_quarantines_with_live_work_and_never_reports_stopped() {
        let mut supervisor = supervisor("ready");
        let generation = supervisor.start().expect("authenticated readiness");
        let guard = supervisor
            .acquire_work_guard(generation)
            .expect("work guard");
        let in_flight = supervisor.begin_work(&guard).expect("tracked work");

        assert!(matches!(
            supervisor.stop(),
            Err(DaemonError::DrainDeadlineExceeded)
        ));
        assert!(matches!(
            supervisor.state(),
            DaemonState::Quarantined(actual) if actual == generation
        ));
        assert!(!guard.is_usable());
        assert_eq!(supervisor.active_in_flight_count(), 1);

        drop(in_flight);
        assert_eq!(supervisor.active_in_flight_count(), 0);
        assert!(supervisor.stop().is_ok());
        assert!(matches!(
            supervisor.state(),
            DaemonState::Quarantined(actual) if actual == generation
        ));
    }

    #[test]
    fn restart_requires_fresh_owner_and_fences_old_generation() {
        let mut supervisor = supervisor("ready");
        let first = supervisor.start().expect("first start");
        let old_guard = supervisor.acquire_work_guard(first).expect("old guard");
        assert!(matches!(
            supervisor.restart(),
            Err(DaemonError::FreshLifecycleIdentityRequired)
        ));
        assert!(old_guard.is_usable());
        let worker_epoch: WorkerEpoch = "0198ab31-6c44-7e8a-b2bb-000000000110"
            .parse()
            .expect("worker epoch");
        let make_identity = |extension_id: &str, generation: i64| {
            DaemonLifecycleIdentity::new(
                extension_id,
                "module-one",
                "control-channel-1",
                1,
                worker_epoch.clone(),
                17,
                generation,
                "control-channel-1",
            )
            .expect("lifecycle identity")
        };
        assert!(matches!(
            supervisor.restart_with_identity(make_identity("org.example.extension", 1)),
            Err(DaemonError::LifecycleIdentityReused)
        ));
        assert!(matches!(
            supervisor.restart_with_identity(make_identity("org.other.extension", 2)),
            Err(DaemonError::LifecycleIdentityMismatch)
        ));

        assert!(matches!(
            supervisor.restart_with_identity(make_identity("org.example.extension", 3)),
            Err(DaemonError::NonMonotonicLifecycleIdentity)
        ));

        supervisor.stop().expect("stop before explicit restart");
        assert!(matches!(
            supervisor.start(),
            Err(DaemonError::FreshLifecycleIdentityRequired)
        ));
        assert!(!old_guard.is_usable());
        let fresh_identity = make_identity("org.example.extension", 2);
        let second = supervisor
            .restart_with_identity(fresh_identity)
            .expect("fresh owner restart");
        assert!(second > first);
        assert!(!old_guard.is_usable());
        assert!(matches!(
            supervisor.require_current_generation(first),
            Err(DaemonError::StaleGeneration { .. })
        ));
        let new_guard = supervisor.acquire_work_guard(second).expect("new guard");
        assert!(new_guard.is_usable());
        supervisor.stop().expect("stop");
    }

    #[test]
    fn automatic_crash_recovery_waits_for_fresh_owner_authority() {
        let mut supervisor = supervisor("ready-exit");
        let first = supervisor.start().expect("first readiness");
        let state = loop {
            std::thread::sleep(Duration::from_millis(2));
            let state = supervisor.poll().expect("poll");
            if !matches!(state, DaemonState::Running(_)) {
                break state;
            }
        };
        assert_eq!(state, DaemonState::AwaitingAuthority(first));
        assert_eq!(supervisor.generation(), Some(first));
        assert_eq!(supervisor.active_work_count(), 0);
        assert!(matches!(
            supervisor.acquire_work_guard(first),
            Err(DaemonError::StaleGeneration { .. }) | Err(DaemonError::WorkNotAdmissible)
        ));
        assert!(matches!(
            supervisor.start(),
            Err(DaemonError::FreshLifecycleIdentityRequired)
        ));
        assert_eq!(
            supervisor.poll().expect("awaiting authority poll"),
            DaemonState::AwaitingAuthority(first)
        );
        supervisor.stop().expect("stop awaiting authority");
    }
}
