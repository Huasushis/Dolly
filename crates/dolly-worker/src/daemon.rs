//! Supervised local daemon process lifecycle.
//!
//! A spawned child is `Starting` until it returns an authenticated readiness
//! line for the exact non-reusable generation, WorkerEpoch, control channel,
//! ownership token, and required storage state. Only then is the generation
//! `Running` and able to issue opaque work guards. Stop and restart close the
//! admission gate before terminating the exact child, and every outstanding
//! guard is fenced before the method returns.

use std::{
    collections::{BTreeMap, VecDeque},
    ffi::OsString,
    fmt,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

use dolly_canonical_json::Sha256Digest;
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

/// Whether an unexpected child exit should create a new generation.
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
    #[error("daemon crash loop is quarantined at generation {0}")]
    CrashLoopQuarantined(DaemonGeneration),
    #[error("daemon work is not admitted")]
    WorkNotAdmissible,
    #[error("daemon work guard is stale")]
    StaleWorkGuard,
}

struct WorkLedger {
    ready_generation: Option<DaemonGeneration>,
    next_guard_id: u64,
    active: BTreeMap<u64, DaemonGeneration>,
}

impl Default for WorkLedger {
    fn default() -> Self {
        Self {
            ready_generation: None,
            next_guard_id: 1,
            active: BTreeMap::new(),
        }
    }
}

/// Opaque work permission bound to one authenticated daemon generation.
pub struct DaemonWorkGuard {
    ledger: Arc<Mutex<WorkLedger>>,
    id: u64,
    generation: DaemonGeneration,
}

impl fmt::Debug for DaemonWorkGuard {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DaemonWorkGuard")
            .field("generation", &self.generation)
            .finish()
    }
}

impl DaemonWorkGuard {
    pub fn generation(&self) -> DaemonGeneration {
        self.generation
    }

    pub fn check(&self) -> Result<(), DaemonError> {
        let ledger = self
            .ledger
            .lock()
            .map_err(|_| DaemonError::StaleWorkGuard)?;
        if ledger.ready_generation == Some(self.generation)
            && ledger.active.get(&self.id) == Some(&self.generation)
        {
            Ok(())
        } else {
            Err(DaemonError::StaleWorkGuard)
        }
    }

    pub fn is_usable(&self) -> bool {
        self.check().is_ok()
    }
}

impl Drop for DaemonWorkGuard {
    fn drop(&mut self) {
        if let Ok(mut ledger) = self.ledger.lock() {
            ledger.active.remove(&self.id);
        }
    }
}

/// Owns one local daemon child and its non-reusable process generations.
pub struct LocalDaemonSupervisor {
    command: DaemonCommand,
    readiness: DaemonReadinessConfig,
    restart_policy: RestartPolicy,
    child: Option<Child>,
    generation: Option<DaemonGeneration>,
    state: DaemonState,
    last_exit_status: Option<ExitStatus>,
    stop_requested: bool,
    work: Arc<Mutex<WorkLedger>>,
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

    pub fn with_config(
        command: DaemonCommand,
        restart_policy: RestartPolicy,
        readiness: DaemonReadinessConfig,
    ) -> Self {
        Self {
            next_backoff: readiness.restart_bounds.initial_backoff,
            command,
            readiness,
            restart_policy,
            child: None,
            generation: None,
            state: DaemonState::Stopped,
            last_exit_status: None,
            stop_requested: false,
            work: Arc::new(Mutex::new(WorkLedger::default())),
            failure_times: VecDeque::new(),
            last_failure: None,
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
        self.work
            .lock()
            .map(|ledger| ledger.active.len())
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
        self.stop_requested = false;
        self.wait_for_backoff();
        self.spawn_next()
    }

    /// Close admission, revoke guards, and terminate the exact child.
    pub fn stop(&mut self) -> Result<(), DaemonError> {
        self.stop_requested = true;
        self.close_admission();
        let Some(mut child) = self.child.take() else {
            self.state = DaemonState::Stopped;
            return Ok(());
        };

        let status = self.terminate_child(&mut child)?;
        self.last_exit_status = Some(status);
        self.state = DaemonState::Stopped;
        Ok(())
    }

    /// Stop the current process and start a fresh fenced generation.
    pub fn restart(&mut self) -> Result<DaemonGeneration, DaemonError> {
        self.stop()?;
        self.start()
    }

    /// Explicit operator action required to leave crash-loop quarantine.
    pub fn clear_quarantine(&mut self) -> Result<(), DaemonError> {
        if self.child.is_some() {
            return Err(DaemonError::AlreadyRunning(
                self.generation.expect("child has a generation"),
            ));
        }
        self.quarantined = false;
        self.failure_times.clear();
        self.last_failure = None;
        self.next_backoff = self.readiness.restart_bounds.initial_backoff;
        self.state = DaemonState::Stopped;
        Ok(())
    }

    /// Observe the child. Automatic restarts are bounded and quarantined.
    pub fn poll(&mut self) -> Result<DaemonState, DaemonError> {
        let status = match self.child.as_mut() {
            Some(child) => child.try_wait().map_err(DaemonError::Process)?,
            None => return Ok(self.state),
        };
        let Some(status) = status else {
            return Ok(self.state);
        };

        self.child.take();
        self.close_admission();
        self.last_exit_status = Some(status);
        let exited_generation = self.generation.ok_or(DaemonError::NotRunning)?;
        self.state = DaemonState::Exited(exited_generation);
        self.record_failure(exited_generation);
        if self.restart_policy == RestartPolicy::OnUnexpectedExit
            && !self.stop_requested
            && !self.quarantined
        {
            self.wait_for_backoff();
            self.spawn_next()?;
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
            DaemonState::Stopped | DaemonState::Exited(_) | DaemonState::Quarantined(_) => {
                Err(DaemonError::StaleGeneration {
                    expected,
                    actual: self.generation,
                })
            }
        }
    }

    /// Issue an opaque guard only after authenticated readiness is live.
    pub fn acquire_work_guard(
        &mut self,
        expected: DaemonGeneration,
    ) -> Result<DaemonWorkGuard, DaemonError> {
        self.require_current_generation(expected)?;
        let mut ledger = self
            .work
            .lock()
            .map_err(|_| DaemonError::WorkNotAdmissible)?;
        if ledger.ready_generation != Some(expected) {
            return Err(DaemonError::WorkNotAdmissible);
        }
        let id = ledger.next_guard_id;
        ledger.next_guard_id = id.checked_add(1).ok_or(DaemonError::GenerationExhausted)?;
        ledger.active.insert(id, expected);
        Ok(DaemonWorkGuard {
            ledger: Arc::clone(&self.work),
            id,
            generation: expected,
        })
    }

    pub fn require_work_guard(&mut self, guard: &DaemonWorkGuard) -> Result<(), DaemonError> {
        guard.check()?;
        self.require_current_generation(guard.generation)?;
        guard.check()
    }

    /// Run one synchronous operation only while its generation guard is live.
    pub fn with_work_guard<T>(
        &mut self,
        guard: &DaemonWorkGuard,
        work: impl FnOnce() -> T,
    ) -> Result<T, DaemonError> {
        self.require_work_guard(guard)?;
        let result = work();
        self.require_work_guard(guard)?;
        Ok(result)
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
        self.close_admission();
        self.last_exit_status = Some(status);
        let generation = self.generation.ok_or(DaemonError::NotRunning)?;
        self.state = DaemonState::Exited(generation);
        self.record_failure(generation);
        Ok(())
    }

    fn spawn_next(&mut self) -> Result<DaemonGeneration, DaemonError> {
        if self.quarantined {
            return Err(DaemonError::CrashLoopQuarantined(
                self.generation.expect("quarantine has a generation"),
            ));
        }
        self.readiness.validate()?;
        let next_value = self
            .generation
            .map(|generation| generation.value())
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(DaemonError::GenerationExhausted)?;
        let generation = DaemonGeneration::new(next_value)?;
        self.generation = Some(generation);
        self.close_admission();
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
                self.record_failure(generation);
                if !self.quarantined {
                    self.state = DaemonState::Exited(generation);
                }
                return Err(DaemonError::Process(error));
            }
        };

        match self.await_readiness(&mut child, generation) {
            Ok(()) => {
                self.child = Some(child);
                self.state = DaemonState::Running(generation);
                self.open_admission(generation);
                self.last_failure = None;
                self.next_backoff = self.readiness.restart_bounds.initial_backoff;
                Ok(generation)
            }
            Err(error) => {
                if let Ok(status) = self.terminate_child(&mut child) {
                    self.last_exit_status = Some(status);
                }
                self.record_failure(generation);
                if !self.quarantined {
                    self.state = DaemonState::Exited(generation);
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
            self.close_admission();
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

    fn close_admission(&self) {
        if let Ok(mut ledger) = self.work.lock() {
            ledger.ready_generation = None;
            ledger.active.clear();
        }
    }

    fn open_admission(&self, generation: DaemonGeneration) {
        if let Ok(mut ledger) = self.work.lock() {
            ledger.ready_generation = Some(generation);
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
        DaemonReadinessConfig::new("worker-epoch-1", "control-channel-1", "owner-secret")
            .expect("readiness")
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
            DaemonState::Exited(_) | DaemonState::Quarantined(_)
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
        supervisor
            .with_work_guard(&guard, || work_calls += 1)
            .expect("guarded work");
        assert_eq!(work_calls, 1);
        supervisor.stop().expect("stop");
        assert!(!guard.is_usable());
        assert!(matches!(
            supervisor.require_work_guard(&guard),
            Err(DaemonError::StaleWorkGuard)
        ));
        assert_eq!(supervisor.active_work_count(), 0);
    }

    #[test]
    fn restart_closes_old_guard_before_new_generation() {
        let mut supervisor = supervisor("ready");
        let first = supervisor.start().expect("first start");
        let old_guard = supervisor.acquire_work_guard(first).expect("old guard");
        let second = supervisor.restart().expect("restart");
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
    fn crash_loop_uses_backoff_and_enters_quarantine_without_authority() {
        let mut supervisor = supervisor("ready-exit");
        let first = supervisor.start().expect("first readiness");
        for _ in 0..32 {
            std::thread::sleep(Duration::from_millis(2));
            let _ = supervisor.poll().expect("poll");
            if matches!(supervisor.state(), DaemonState::Quarantined(_)) {
                break;
            }
        }
        assert!(matches!(
            supervisor.state(),
            DaemonState::Quarantined(generation) if generation > first
        ));
        assert_eq!(supervisor.active_work_count(), 0);
        assert!(matches!(
            supervisor.acquire_work_guard(first),
            Err(DaemonError::StaleGeneration { .. }) | Err(DaemonError::WorkNotAdmissible)
        ));
        assert!(matches!(supervisor.poll(), Ok(DaemonState::Quarantined(_))));
        supervisor.stop().expect("stop quarantine");
    }
}
