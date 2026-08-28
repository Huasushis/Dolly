//! Supervised local daemon process lifecycle.
//!
//! [`LocalDaemonSupervisor`] owns the child process, marks each successful
//! start with a fresh generation, and rejects work carrying an older
//! generation. An unexpected exit is observed by [`LocalDaemonSupervisor::poll`]
//! and restarted when the configured policy permits it. Stop marks the
//! supervisor before killing the child, so a stopped generation cannot pass a
//! lifecycle fence.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus};
use thiserror::Error;

/// A non-zero process generation assigned after a successful local start.
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

/// Observable supervisor state. An exited generation is never current again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DaemonState {
    Stopped,
    Running(DaemonGeneration),
    Exited(DaemonGeneration),
}

/// Fail-closed lifecycle errors. No command arguments or environment values
/// are included in an error message.
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
}

/// Owns one local daemon child and its non-reusable process generations.
pub struct LocalDaemonSupervisor {
    command: DaemonCommand,
    restart_policy: RestartPolicy,
    child: Option<Child>,
    generation: Option<DaemonGeneration>,
    state: DaemonState,
    last_exit_status: Option<ExitStatus>,
    stop_requested: bool,
}

impl LocalDaemonSupervisor {
    /// Create a supervisor that restarts an unexpected exit by default.
    pub fn new(command: DaemonCommand) -> Self {
        Self::with_restart_policy(command, RestartPolicy::OnUnexpectedExit)
    }

    pub fn with_restart_policy(command: DaemonCommand, restart_policy: RestartPolicy) -> Self {
        Self {
            command,
            restart_policy,
            child: None,
            generation: None,
            state: DaemonState::Stopped,
            last_exit_status: None,
            stop_requested: false,
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

    /// Start the configured child and assign the next generation.
    pub fn start(&mut self) -> Result<DaemonGeneration, DaemonError> {
        self.reap_exited_child()?;
        if let Some(generation) = self.live_generation() {
            return Err(DaemonError::AlreadyRunning(generation));
        }
        self.stop_requested = false;
        self.spawn_next()
    }

    /// Stop before killing the child. A later start receives a new generation.
    pub fn stop(&mut self) -> Result<(), DaemonError> {
        self.stop_requested = true;
        let Some(mut child) = self.child.take() else {
            self.state = DaemonState::Stopped;
            return Ok(());
        };

        match child.try_wait().map_err(DaemonError::Process)? {
            Some(status) => self.last_exit_status = Some(status),
            None => {
                child.kill().map_err(DaemonError::Process)?;
                self.last_exit_status = Some(child.wait().map_err(DaemonError::Process)?);
            }
        }
        self.state = DaemonState::Stopped;
        Ok(())
    }

    /// Stop the current process and start a fresh fenced generation.
    pub fn restart(&mut self) -> Result<DaemonGeneration, DaemonError> {
        self.stop()?;
        self.start()
    }

    /// Observe the child. Unexpected exits are restarted at a new generation.
    pub fn poll(&mut self) -> Result<DaemonState, DaemonError> {
        let status = match self.child.as_mut() {
            Some(child) => child.try_wait().map_err(DaemonError::Process)?,
            None => return Ok(self.state),
        };
        let Some(status) = status else {
            if let Some(generation) = self.generation {
                self.state = DaemonState::Running(generation);
            }
            return Ok(self.state);
        };

        self.child.take();
        self.last_exit_status = Some(status);
        let exited_generation = self.generation.ok_or(DaemonError::NotRunning)?;
        self.state = DaemonState::Exited(exited_generation);
        if self.restart_policy == RestartPolicy::OnUnexpectedExit && !self.stop_requested {
            self.spawn_next()?;
        }
        Ok(self.state)
    }

    /// Require that work belongs to the currently running child generation.
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
            DaemonState::Stopped | DaemonState::Exited(_) => Err(DaemonError::StaleGeneration {
                expected,
                actual: self.generation,
            }),
        }
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
        if let Some(generation) = self.generation {
            self.state = DaemonState::Exited(generation);
        }
        Ok(())
    }

    fn spawn_next(&mut self) -> Result<DaemonGeneration, DaemonError> {
        let next_value = self
            .generation
            .map(|generation| generation.value())
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(DaemonError::GenerationExhausted)?;
        let generation = DaemonGeneration::new(next_value)?;
        let mut command = Command::new(&self.command.program);
        command.args(&self.command.arguments);
        command.envs(&self.command.environment);
        let child = command.spawn().map_err(DaemonError::Process)?;
        self.child = Some(child);
        self.generation = Some(generation);
        self.state = DaemonState::Running(generation);
        self.last_exit_status = None;
        Ok(generation)
    }
}

impl Drop for LocalDaemonSupervisor {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn sleeping_command() -> DaemonCommand {
        DaemonCommand::new("sh")
            .expect("command")
            .arg("-c")
            .arg("sleep 2")
    }

    #[test]
    fn restart_assigns_non_reusable_generation() {
        let mut supervisor = LocalDaemonSupervisor::new(sleeping_command());
        let first = supervisor.start().expect("first start");
        let second = supervisor.restart().expect("restart");
        assert!(second > first);
        assert!(matches!(
            supervisor.require_current_generation(first),
            Err(DaemonError::StaleGeneration { .. })
        ));
        supervisor
            .require_current_generation(second)
            .expect("current generation");
        supervisor.stop().expect("stop");
        assert_eq!(supervisor.state(), DaemonState::Stopped);
    }

    #[test]
    fn unexpected_exit_is_restarted_when_supervised() {
        let command = DaemonCommand::new("sh")
            .expect("command")
            .arg("-c")
            .arg("exit 0");
        let mut supervisor = LocalDaemonSupervisor::new(command);
        let first = supervisor.start().expect("first start");
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(2));
            let _ = supervisor.poll().expect("poll");
            if supervisor
                .generation()
                .is_some_and(|generation| generation > first)
            {
                break;
            }
        }
        assert!(
            supervisor
                .generation()
                .is_some_and(|generation| generation > first)
        );
        supervisor.stop().expect("stop");
    }
}
