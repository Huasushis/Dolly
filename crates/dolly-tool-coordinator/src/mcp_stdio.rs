#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use dolly_canonical_json::{
    CanonicalJsonObject, CanonicalJsonValue, PROTOCOL_WIRE_PARSE_DEPTH, ParseLimits, Sha256Digest,
    canonicalize, parse_core_json,
};
use dolly_core_domain::{ExtensionGeneration, ExtensionId, WorkerEpoch};
use dolly_storage::mcp_readiness::{
    MCP_PROTOCOL_VERSION_2025_06_18, McpHandshakeObservation, McpTransportBinding,
    McpTransportProbe, McpTransportProbeError, McpTransportReadiness,
};
use dolly_storage::runtime_binding::ProcessGeneration;
use dolly_storage::tool_broker_authority::ToolDispatchAuthority;

use crate::permit::SendPermitBinding;
use crate::ports::parse_rfc3339_utc;
use crate::service::{ToolTransport, TransportOutcome};

const INITIALIZE_REQUEST_ID: &str = "dolly-initialize";
const MCP_ADAPTER: &str = "mcp";
const MCP_STDIO_KIND: &str = "stdio";
/// Static bounds applied to every stdio application frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StdioTransportLimits {
    pub(crate) max_frame_bytes: usize,
    pub(crate) max_nesting_depth: u16,
}

impl StdioTransportLimits {
    pub fn new(
        max_frame_bytes: usize,
        max_nesting_depth: u16,
    ) -> Result<Self, StdioTransportError> {
        if max_frame_bytes < 2
            || max_nesting_depth == 0
            || max_nesting_depth > PROTOCOL_WIRE_PARSE_DEPTH
        {
            return Err(StdioTransportError::InvalidLimits);
        }
        Ok(Self {
            max_frame_bytes,
            max_nesting_depth,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StdioTransportError {
    InvalidLimits,
    InvalidDeadline,
    MissingPipe,
    ProcessIdentityMismatch,
    InvalidFrame,
    FrameTooLarge,
    RequestMismatch,
    NotInitialized,
    AlreadyInitialized,
    AlreadyUsed,
    Cancelled,
    Deadline,
    Disconnected,
    Io,
    Readiness(String),
}
/// Cancellation is local to one Host-owned session. It never creates a retry
/// or an alternate send permit.
#[derive(Clone, Debug)]
pub(crate) struct StdioCancellation {
    cancelled: Arc<AtomicBool>,
    process: Arc<ProcessControl>,
}

impl StdioCancellation {
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.process.stop();
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}
#[derive(Debug)]
struct ProcessControl {
    child: Option<Arc<Mutex<Child>>>,
}

impl ProcessControl {
    fn none() -> Arc<Self> {
        Arc::new(Self { child: None })
    }

    fn child(child: Child) -> Arc<Self> {
        Arc::new(Self {
            child: Some(Arc::new(Mutex::new(child))),
        })
    }

    fn stop(&self) {
        let Some(child) = &self.child else {
            return;
        };
        let Ok(mut child) = child.lock() else {
            return;
        };
        let _ = child.kill();
        let _ = child.wait();
    }
}
#[derive(Clone)]
pub struct HostMcpStdioProcessHandle {
    process: Arc<ProcessControl>,
    identity: HostVerifiedMcpStdioIdentity,
}

impl HostMcpStdioProcessHandle {
    /// Stop the Host-owned child and wait for its exit.
    pub fn terminate(&self) {
        self.process.stop();
    }
}

/// Typed installed-child claims supplied by Host. The claims remain untrusted
/// until [`InstalledChildVerifier`] checks the live child and artifact bytes.
#[derive(Clone)]
pub struct HostMcpStdioInstalledChildAttestation {
    server_id: String,
    adapter: String,
    protocol_version: String,
    transport_kind: String,
    endpoint: String,
    endpoint_digest: Sha256Digest,
    package_digest: Sha256Digest,
    package_path: PathBuf,
    executable_digest: Sha256Digest,
    executable_path: PathBuf,
    transport_digest: Sha256Digest,
    daemon_installation_id: String,
    instance_id: String,
    controller_generation: ExtensionGeneration,
    worker_epoch: WorkerEpoch,
    extension_alias: ExtensionId,
    extension_generation: ExtensionGeneration,
    runtime_binding_digest: Sha256Digest,
    session_id: String,
    process_id: u32,
}

impl HostMcpStdioInstalledChildAttestation {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        server_id: String,
        adapter: String,
        protocol_version: String,
        transport_kind: String,
        endpoint: String,
        endpoint_digest: Sha256Digest,
        package_digest: Sha256Digest,
        package_path: PathBuf,
        executable_digest: Sha256Digest,
        executable_path: PathBuf,
        transport_digest: Sha256Digest,
        daemon_installation_id: String,
        instance_id: String,
        controller_generation: ExtensionGeneration,
        worker_epoch: WorkerEpoch,
        extension_alias: ExtensionId,
        extension_generation: ExtensionGeneration,
        runtime_binding_digest: Sha256Digest,
        session_id: String,
        process_id: u32,
    ) -> Self {
        Self {
            server_id,
            adapter,
            protocol_version,
            transport_kind,
            endpoint,
            endpoint_digest,
            package_digest,
            package_path,
            executable_digest,
            executable_path,
            transport_digest,
            daemon_installation_id,
            instance_id,
            controller_generation,
            worker_epoch,
            extension_alias,
            extension_generation,
            runtime_binding_digest,
            session_id,
            process_id,
        }
    }
}

/// Host-issued verified process/session capability. No raw Child constructor
/// is exposed; only the installed-child verifier can mint this value.
pub(crate) struct HostIssuedMcpStdioProcess {
    child: Child,
    attestation: HostMcpStdioInstalledChildAttestation,
}

impl HostIssuedMcpStdioProcess {
    fn abort(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Internal verifier seam for the installed-child authority. The verifier
/// owns the attestation and is the only code allowed to pair it with a Child.
struct InstalledChildVerifier;

impl InstalledChildVerifier {
    fn issue(
        mut child: Child,
        attestation: HostMcpStdioInstalledChildAttestation,
    ) -> Result<HostIssuedMcpStdioProcess, StdioTransportError> {
        if child.id() != attestation.process_id
            || !attestation_is_self_consistent(&attestation)
            || !installed_child_is_attested(&child, &attestation)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(StdioTransportError::ProcessIdentityMismatch);
        }
        Ok(HostIssuedMcpStdioProcess { child, attestation })
    }
}

pub(crate) fn host_session_from_installed_child(
    child: Child,
    attestation: HostMcpStdioInstalledChildAttestation,
    process_generation: &ProcessGeneration,
) -> Result<(HostOwnedMcpStdioSession, HostMcpStdioProcessHandle), StdioTransportError> {
    let process = InstalledChildVerifier::issue(child, attestation)?;
    let session = HostOwnedMcpStdioSession::from_host_issued_process(process, process_generation)?;
    let handle = session.process_handle();
    Ok((session, handle))
}

fn attestation_is_self_consistent(attestation: &HostMcpStdioInstalledChildAttestation) -> bool {
    let Ok((_, endpoint_digest)) =
        canonicalize(&CanonicalJsonValue::String(attestation.endpoint.clone()))
    else {
        return false;
    };
    endpoint_digest == attestation.endpoint_digest
}

fn installed_child_is_attested(
    child: &Child,
    attestation: &HostMcpStdioInstalledChildAttestation,
) -> bool {
    #[cfg(target_os = "linux")]
    {
        let Ok(package) = std::fs::read(&attestation.package_path) else {
            return false;
        };
        if Sha256Digest::compute(&package) != attestation.package_digest {
            return false;
        }
        let Ok(actual_link) = std::fs::read_link(format!("/proc/{}/exe", child.id())) else {
            return false;
        };
        let Ok(actual_path) = std::fs::canonicalize(actual_link) else {
            return false;
        };
        let Ok(expected_path) = std::fs::canonicalize(&attestation.executable_path) else {
            return false;
        };
        if actual_path != expected_path {
            return false;
        }
        let Ok(executable) = std::fs::read(actual_path) else {
            return false;
        };
        Sha256Digest::compute(&executable) == attestation.executable_digest
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (child, attestation);
        false
    }
}

#[derive(Clone)]
struct HostVerifiedMcpStdioIdentity {
    server_id: String,
    adapter: String,
    protocol_version: String,
    transport_kind: String,
    endpoint: String,
    endpoint_digest: Sha256Digest,
    package_digest: Sha256Digest,
    executable_digest: Sha256Digest,
    transport_digest: Sha256Digest,
    daemon_installation_id: String,
    instance_id: String,
    controller_generation: ExtensionGeneration,
    worker_epoch: WorkerEpoch,
    extension_alias: ExtensionId,
    extension_generation: ExtensionGeneration,
    runtime_binding_digest: Sha256Digest,
    session_id: String,
}

pub(crate) struct HostOwnedMcpStdioSession {
    reader: ChildStdout,
    writer: ChildStdin,
    handle: HostMcpStdioProcessHandle,
}

impl HostOwnedMcpStdioSession {
    pub(crate) fn from_host_issued_process(
        mut process: HostIssuedMcpStdioProcess,
        process_generation: &ProcessGeneration,
    ) -> Result<Self, StdioTransportError> {
        let attestation = process.attestation.clone();
        if attestation.runtime_binding_digest != *process_generation.binding_digest()
            || attestation.controller_generation != process_generation.controller_generation()
            || attestation.worker_epoch != *process_generation.worker_epoch()
            || attestation.extension_alias != *process_generation.extension_alias()
            || attestation.extension_generation != process_generation.extension_generation()
        {
            process.abort();
            return Err(StdioTransportError::ProcessIdentityMismatch);
        }
        let reader = match process.child.stdout.take() {
            Some(reader) => reader,
            None => {
                process.abort();
                return Err(StdioTransportError::MissingPipe);
            }
        };
        let writer = match process.child.stdin.take() {
            Some(writer) => writer,
            None => {
                process.abort();
                return Err(StdioTransportError::MissingPipe);
            }
        };
        let process = ProcessControl::child(process.child);
        let identity = HostVerifiedMcpStdioIdentity {
            server_id: attestation.server_id,
            adapter: attestation.adapter,
            protocol_version: attestation.protocol_version,
            transport_kind: attestation.transport_kind,
            endpoint: attestation.endpoint,
            endpoint_digest: attestation.endpoint_digest,
            package_digest: attestation.package_digest,
            executable_digest: attestation.executable_digest,
            transport_digest: attestation.transport_digest,
            daemon_installation_id: attestation.daemon_installation_id,
            instance_id: attestation.instance_id,
            controller_generation: attestation.controller_generation,
            worker_epoch: attestation.worker_epoch,
            extension_alias: attestation.extension_alias,
            extension_generation: attestation.extension_generation,
            runtime_binding_digest: attestation.runtime_binding_digest,
            session_id: attestation.session_id,
        };
        Ok(Self {
            reader,
            writer,
            handle: HostMcpStdioProcessHandle { process, identity },
        })
    }

    pub(crate) fn process_handle(&self) -> HostMcpStdioProcessHandle {
        self.handle.clone()
    }

    fn into_parts(self) -> (ChildStdout, ChildStdin, Arc<ProcessControl>) {
        (self.reader, self.writer, self.handle.process)
    }
}

#[derive(Debug)]
enum ReaderEvent {
    Frame(Vec<u8>),
    ProtocolError,
    Eof,
    Io,
}

/// One initialized stdio session. The Host retains the process handle; this
/// object owns only the bounded I/O seam and never terminates on normal Drop.
pub(crate) struct McpStdioSession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    events: mpsc::Receiver<ReaderEvent>,
    cancellation: StdioCancellation,
    limits: StdioTransportLimits,
    initialized: bool,
}
impl McpStdioSession {
    fn from_parts<R, W>(
        reader: R,
        writer: W,
        process: Arc<ProcessControl>,
        limits: StdioTransportLimits,
    ) -> Self
    where
        R: Read + Send + 'static,
        W: Write + Send + 'static,
    {
        let (events_tx, events_rx) = mpsc::sync_channel(1);
        let cancellation = StdioCancellation {
            cancelled: Arc::new(AtomicBool::new(false)),
            process: process.clone(),
        };
        let reader_cancellation = cancellation.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(reader);
            loop {
                if reader_cancellation.is_cancelled() {
                    break;
                }
                match read_frame(&mut reader, limits) {
                    Ok(Some(frame)) => {
                        if events_tx.send(ReaderEvent::Frame(frame)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => {
                        let _ = events_tx.send(ReaderEvent::Eof);
                        break;
                    }
                    Err(FrameError::TooLarge | FrameError::Invalid) => {
                        let _ = events_tx.send(ReaderEvent::ProtocolError);
                        break;
                    }
                    Err(FrameError::Io) => {
                        let _ = events_tx.send(ReaderEvent::Io);
                        break;
                    }
                }
            }
        });
        Self {
            writer: Arc::new(Mutex::new(Box::new(writer))),
            events: events_rx,
            cancellation,
            limits,
            initialized: false,
        }
    }

    pub(crate) fn cancellation(&self) -> StdioCancellation {
        self.cancellation.clone()
    }

    pub(crate) fn initialize(&mut self, deadline: Instant) -> Result<(), StdioTransportError> {
        if self.initialized {
            return Err(StdioTransportError::AlreadyInitialized);
        }
        let request = initialize_request()?;
        let response = self.exchange(&request, INITIALIZE_REQUEST_ID, deadline)?;
        if let Err(error) = validate_initialize_response(&response, self.limits.max_nesting_depth) {
            self.abort();
            return Err(error);
        }
        let notification = initialized_notification()?;
        self.send_frame(&notification, deadline)?;
        self.initialized = true;
        Ok(())
    }

    fn exchange(
        &mut self,
        request_bytes: &[u8],
        expected_request_id: &str,
        deadline: Instant,
    ) -> Result<Vec<u8>, StdioTransportError> {
        if self.cancellation.is_cancelled() {
            return Err(StdioTransportError::Cancelled);
        }
        if request_bytes.len().saturating_add(1) > self.limits.max_frame_bytes {
            return Err(StdioTransportError::FrameTooLarge);
        }
        if request_id(request_bytes, self.limits.max_nesting_depth)? != expected_request_id {
            return Err(StdioTransportError::RequestMismatch);
        }
        self.send_frame(request_bytes, deadline)?;
        loop {
            if self.cancellation.is_cancelled() {
                self.abort();
                return Err(StdioTransportError::Cancelled);
            }
            let now = Instant::now();
            if now >= deadline {
                self.abort();
                return Err(StdioTransportError::Deadline);
            }
            match self.events.recv_timeout(
                deadline
                    .saturating_duration_since(now)
                    .min(Duration::from_millis(10)),
            ) {
                Ok(ReaderEvent::Frame(frame)) => {
                    let response_id = match response_id(&frame, self.limits.max_nesting_depth) {
                        Ok(response_id) => response_id,
                        Err(error) => {
                            self.abort();
                            return Err(error);
                        }
                    };
                    if response_id != expected_request_id {
                        self.abort();
                        return Err(StdioTransportError::RequestMismatch);
                    }
                    return Ok(frame);
                }
                Ok(ReaderEvent::ProtocolError) => {
                    self.abort();
                    return Err(StdioTransportError::InvalidFrame);
                }
                Ok(ReaderEvent::Eof) => {
                    self.abort();
                    return Err(StdioTransportError::Disconnected);
                }
                Ok(ReaderEvent::Io) => {
                    self.abort();
                    return Err(StdioTransportError::Io);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.abort();
                    return Err(StdioTransportError::Disconnected);
                }
            }
        }
    }

    fn send_frame(&self, payload: &[u8], deadline: Instant) -> Result<(), StdioTransportError> {
        if payload.len().saturating_add(1) > self.limits.max_frame_bytes {
            return Err(StdioTransportError::FrameTooLarge);
        }
        if self.cancellation.is_cancelled() {
            return Err(StdioTransportError::Cancelled);
        }
        let writer = Arc::clone(&self.writer);
        let payload = payload.to_vec();
        let (result_tx, result_rx) = mpsc::channel();
        thread::spawn(move || {
            let result = (|| {
                let mut writer = writer.lock().map_err(|_| ())?;
                writer.write_all(&payload).map_err(|_| ())?;
                writer.write_all(b"\n").map_err(|_| ())?;
                writer.flush().map_err(|_| ())?;
                Ok::<(), ()>(())
            })();
            let _ = result_tx.send(result);
        });
        loop {
            if self.cancellation.is_cancelled() {
                self.abort();
                return Err(StdioTransportError::Cancelled);
            }
            let now = Instant::now();
            if now >= deadline {
                self.abort();
                return Err(StdioTransportError::Deadline);
            }
            match result_rx.recv_timeout(
                deadline
                    .saturating_duration_since(now)
                    .min(Duration::from_millis(10)),
            ) {
                Ok(Ok(())) => return Ok(()),
                Ok(Err(())) => {
                    self.abort();
                    return Err(StdioTransportError::Io);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.abort();
                    return Err(StdioTransportError::Io);
                }
            }
        }
    }

    fn abort(&self) {
        self.cancellation.cancel();
    }
}

impl Drop for McpStdioSession {
    fn drop(&mut self) {
        // The Host retains the process handle and owns normal lifecycle.
        // Ambiguous exchange paths call abort before this point.
    }
}

/// The production probe is created only from a Host-owned verified session
/// plus the Host-retained process handle.
pub(crate) struct McpStdioProbe {
    session: Option<McpStdioSession>,
    host_handle: HostMcpStdioProcessHandle,
    identity: HostVerifiedMcpStdioIdentity,
    deadline: Instant,
    observed: bool,
}

impl McpStdioProbe {
    pub(crate) fn from_host_session(
        host_session: HostOwnedMcpStdioSession,
        host_handle: HostMcpStdioProcessHandle,
        limits: StdioTransportLimits,
        deadline: Instant,
    ) -> Result<Self, StdioTransportError> {
        if !Arc::ptr_eq(&host_session.handle.process, &host_handle.process) {
            host_session.handle.terminate();
            host_handle.terminate();
            return Err(StdioTransportError::ProcessIdentityMismatch);
        }
        let identity = host_session.handle.identity.clone();
        let (reader, writer, process) = host_session.into_parts();
        Ok(Self {
            session: Some(McpStdioSession::from_parts(reader, writer, process, limits)),
            host_handle,
            identity,
            deadline,
            observed: false,
        })
    }

    pub(crate) fn abort(&self) {
        if let Some(session) = self.session.as_ref() {
            session.abort();
        } else {
            self.host_handle.terminate();
        }
    }
    pub(crate) fn set_deadline(&mut self, deadline: Instant) {
        self.deadline = deadline;
    }

    pub(crate) fn into_transport(
        mut self,
        readiness: &McpTransportReadiness,
        authority: &ToolDispatchAuthority,
        permit: &SendPermitBinding,
    ) -> Result<McpStdioTransport, StdioTransportError> {
        if readiness.transport_kind() != MCP_STDIO_KIND
            || readiness.server_id() != authority.server_id()
            || readiness.readiness_digest() != authority.readiness_digest()
            || readiness.adapter() != self.identity.adapter
            || readiness.protocol_version() != self.identity.protocol_version
            || readiness.endpoint_digest() != &self.identity.endpoint_digest
            || readiness.transport_digest() != &self.identity.transport_digest
            || readiness.binding_digest() != &self.identity.runtime_binding_digest
            || !authority.permits_binding(
                permit.config_revision,
                &permit.tool_server_id,
                permit.tool_server_generation,
            )
            || readiness.server_id() != permit.tool_server_id
            || authority.tool_server_generation() != permit.tool_server_generation
        {
            self.abort();
            return Err(StdioTransportError::ProcessIdentityMismatch);
        }
        if !self.observed {
            self.abort();
            return Err(StdioTransportError::NotInitialized);
        }
        let Some(session) = self.session.take() else {
            self.host_handle.terminate();
            return Err(StdioTransportError::NotInitialized);
        };
        Ok(McpStdioTransport {
            session,
            host_handle: self.host_handle,
            expected_request_id: permit.server_request_id.clone(),
            deadline: self.deadline,
            used: false,
        })
    }
    pub(crate) fn call_reusable(
        &mut self,
        readiness: &McpTransportReadiness,
        authority: &ToolDispatchAuthority,
        permit: &SendPermitBinding,
        request_bytes: &[u8],
    ) -> TransportOutcome {
        if readiness.transport_kind() != MCP_STDIO_KIND
            || readiness.server_id() != authority.server_id()
            || readiness.readiness_digest() != authority.readiness_digest()
            || readiness.adapter() != self.identity.adapter
            || readiness.protocol_version() != self.identity.protocol_version
            || readiness.endpoint_digest() != &self.identity.endpoint_digest
            || readiness.transport_digest() != &self.identity.transport_digest
            || readiness.binding_digest() != &self.identity.runtime_binding_digest
            || !authority.permits_binding(
                permit.config_revision,
                &permit.tool_server_id,
                permit.tool_server_generation,
            )
            || readiness.server_id() != permit.tool_server_id
            || authority.tool_server_generation() != permit.tool_server_generation
        {
            self.abort();
            return TransportOutcome::Error(format_transport_error(
                StdioTransportError::ProcessIdentityMismatch,
            ));
        }
        if !self.observed {
            self.abort();
            return TransportOutcome::Error(format_transport_error(
                StdioTransportError::NotInitialized,
            ));
        }
        let Some(session) = self.session.take() else {
            self.host_handle.terminate();
            return TransportOutcome::Error(format_transport_error(
                StdioTransportError::NotInitialized,
            ));
        };
        let mut transport = McpStdioTransport {
            session,
            host_handle: self.host_handle.clone(),
            expected_request_id: permit.server_request_id.clone(),
            deadline: self.deadline,
            used: false,
        };
        let outcome = transport.call(request_bytes);
        if matches!(outcome, TransportOutcome::Response(_)) {
            self.session = Some(transport.session);
        } else {
            transport.abort();
        }
        outcome
    }
}

impl McpTransportProbe for McpStdioProbe {
    fn observe(
        &mut self,
        binding: &McpTransportBinding,
    ) -> Result<McpHandshakeObservation, McpTransportProbeError> {
        if self.observed {
            return Err(McpTransportProbeError::Ambiguous(
                "stdio session was observed more than once".to_owned(),
            ));
        }
        if binding.adapter() != MCP_ADAPTER
            || binding.protocol_version() != MCP_PROTOCOL_VERSION_2025_06_18
            || binding.transport_kind() != MCP_STDIO_KIND
            || !identity_matches_binding(&self.identity, binding)
        {
            return Err(McpTransportProbeError::Failed(
                "Host-verified stdio identity does not match the current binding".to_owned(),
            ));
        }
        self.session
            .as_mut()
            .ok_or_else(|| {
                McpTransportProbeError::Ambiguous("stdio session is consumed".to_owned())
            })?
            .initialize(self.deadline)
            .map_err(|_| {
                McpTransportProbeError::Failed("MCP initialize lifecycle failed".to_owned())
            })?;
        self.observed = true;
        Ok(McpHandshakeObservation {
            server_id: Some(self.identity.server_id.clone()),
            adapter: Some(self.identity.adapter.clone()),
            daemon_installation_id: Some(self.identity.daemon_installation_id.clone()),
            instance_id: Some(self.identity.instance_id.clone()),
            controller_generation: Some(self.identity.controller_generation),
            worker_epoch: Some(self.identity.worker_epoch.clone()),
            extension_alias: Some(self.identity.extension_alias.clone()),
            extension_generation: Some(self.identity.extension_generation),
            runtime_binding_digest: Some(self.identity.runtime_binding_digest.clone()),
            transport_kind: Some(self.identity.transport_kind.clone()),
            endpoint: Some(self.identity.endpoint.clone()),
            transport_digest: Some(self.identity.transport_digest.clone()),
            initialize_request_protocol_version: Some(MCP_PROTOCOL_VERSION_2025_06_18.to_owned()),
            initialize_response_protocol_version: Some(MCP_PROTOCOL_VERSION_2025_06_18.to_owned()),
            initialized_notification_sent: true,
            session_ids: vec![self.identity.session_id.clone()],
        })
    }
}

fn identity_matches_binding(
    identity: &HostVerifiedMcpStdioIdentity,
    binding: &McpTransportBinding,
) -> bool {
    let package_digest = identity.package_digest.to_canonical_string();
    let executable_digest = identity.executable_digest.to_canonical_string();
    identity.server_id == binding.server_id()
        && identity.adapter == binding.adapter()
        && identity.protocol_version == binding.protocol_version()
        && identity.transport_kind == binding.transport_kind()
        && identity.endpoint == binding.endpoint()
        && identity.endpoint_digest == *binding.endpoint_digest()
        && identity.transport_digest == *binding.transport_digest()
        && string_member(binding.transport(), "package_digest") == Some(package_digest.as_str())
        && string_member(binding.transport(), "executable_digest")
            == Some(executable_digest.as_str())
}
pub(crate) fn absolute_deadline(payload: &str) -> Result<Instant, StdioTransportError> {
    let deadline = parse_rfc3339_utc(payload).ok_or(StdioTransportError::InvalidDeadline)?;
    let now_system = SystemTime::now();
    let now_instant = Instant::now();
    let remaining = deadline.duration_since(now_system).unwrap_or_default();
    now_instant
        .checked_add(remaining)
        .ok_or(StdioTransportError::InvalidDeadline)
}

/// One-use stdio tools/call transport. Authority is checked before it is
/// constructed; the transport then enforces exact request identity and one
/// call per permit.
pub(crate) struct McpStdioTransport {
    session: McpStdioSession,
    host_handle: HostMcpStdioProcessHandle,
    expected_request_id: String,
    deadline: Instant,
    used: bool,
}

#[cfg(test)]
fn test_identity() -> HostVerifiedMcpStdioIdentity {
    let endpoint = "bin/dolly-fs-tools".to_owned();
    let endpoint_digest = canonicalize(&CanonicalJsonValue::String(endpoint.clone()))
        .expect("endpoint digest")
        .1;
    HostVerifiedMcpStdioIdentity {
        server_id: "fs".to_owned(),
        adapter: MCP_ADAPTER.to_owned(),
        protocol_version: MCP_PROTOCOL_VERSION_2025_06_18.to_owned(),
        transport_kind: MCP_STDIO_KIND.to_owned(),
        endpoint,
        endpoint_digest,
        package_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
            .parse()
            .expect("package digest"),
        executable_digest:
            "sha256:3333333333333333333333333333333333333333333333333333333333333333"
                .parse()
                .expect("executable digest"),
        transport_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222"
            .parse()
            .expect("transport digest"),
        daemon_installation_id: "daemon-1".to_owned(),
        instance_id: "instance-1".to_owned(),
        controller_generation: ExtensionGeneration::new(1).expect("controller generation"),
        worker_epoch: "0198ab31-6c44-7e8a-b2bb-000000000001"
            .parse()
            .expect("worker epoch"),
        extension_alias: "org.dolly.tools".parse().expect("extension alias"),
        extension_generation: ExtensionGeneration::new(1).expect("extension generation"),
        runtime_binding_digest:
            "sha256:4444444444444444444444444444444444444444444444444444444444444444"
                .parse()
                .expect("runtime binding digest"),
        session_id: "session-1".to_owned(),
    }
}

impl McpStdioTransport {
    pub(crate) fn cancellation(&self) -> StdioCancellation {
        self.session.cancellation()
    }

    fn validate_request(&self, request_bytes: &[u8]) -> Result<(), StdioTransportError> {
        if request_bytes.len().saturating_add(1) > self.session.limits.max_frame_bytes {
            return Err(StdioTransportError::FrameTooLarge);
        }
        let value = parse_core_json(
            request_bytes,
            ParseLimits::new(self.session.limits.max_nesting_depth)
                .map_err(|_| StdioTransportError::InvalidLimits)?,
        )
        .map_err(|_| StdioTransportError::InvalidFrame)?;
        let object = as_object(&value).ok_or(StdioTransportError::InvalidFrame)?;
        if string_member(object, "jsonrpc") != Some("2.0")
            || string_member(object, "method") != Some("tools/call")
            || string_member(object, "id") != Some(self.expected_request_id.as_str())
        {
            return Err(StdioTransportError::RequestMismatch);
        }
        Ok(())
    }

    #[cfg(test)]
    fn test(session: McpStdioSession, request_id: &str, deadline: Instant) -> Self {
        let process = ProcessControl::none();
        Self {
            session,
            host_handle: HostMcpStdioProcessHandle {
                process,
                identity: test_identity(),
            },
            expected_request_id: request_id.to_owned(),
            deadline,
            used: false,
        }
    }
}
impl ToolTransport for McpStdioTransport {
    fn abort(&mut self) {
        self.session.abort();
    }

    fn call(&mut self, request_bytes: &[u8]) -> TransportOutcome {
        if !self.session.initialized {
            self.session.abort();
            return TransportOutcome::Error(format_transport_error(
                StdioTransportError::NotInitialized,
            ));
        }
        if self.used {
            self.session.abort();
            return TransportOutcome::Error(format_transport_error(
                StdioTransportError::AlreadyUsed,
            ));
        }
        self.used = true;
        if let Err(error) = self.validate_request(request_bytes) {
            self.session.abort();
            return TransportOutcome::Error(format_transport_error(error));
        }
        match self
            .session
            .exchange(request_bytes, &self.expected_request_id, self.deadline)
        {
            Ok(response) => {
                if complete_non_null_result(&response, self.session.limits.max_nesting_depth) {
                    TransportOutcome::Response(response)
                } else {
                    self.session.abort();
                    TransportOutcome::Error("MCP response has no complete result".to_owned())
                }
            }
            Err(StdioTransportError::Deadline) => {
                self.session.abort();
                TransportOutcome::Timeout
            }
            Err(error) => {
                self.session.abort();
                TransportOutcome::Error(format_transport_error(error))
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameError {
    TooLarge,
    Invalid,
    Io,
}

fn read_frame<R: BufRead>(
    reader: &mut R,
    limits: StdioTransportLimits,
) -> Result<Option<Vec<u8>>, FrameError> {
    let mut frame = Vec::new();
    loop {
        let buffer = reader.fill_buf().map_err(|_| FrameError::Io)?;
        if buffer.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(FrameError::Invalid)
            };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |index| index + 1);
        if frame.len().saturating_add(take) > limits.max_frame_bytes {
            return Err(FrameError::TooLarge);
        }
        frame.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if newline.is_none() {
            continue;
        }
        frame.pop();
        if frame.last() == Some(&b'\r') {
            frame.pop();
        }
        if frame.is_empty() || !is_json_object(&frame, limits.max_nesting_depth) {
            return Err(FrameError::Invalid);
        }
        return Ok(Some(frame));
    }
}

fn is_json_object(bytes: &[u8], max_nesting_depth: u16) -> bool {
    let Ok(limits) = ParseLimits::new(max_nesting_depth) else {
        return false;
    };
    matches!(
        parse_core_json(bytes, limits),
        Ok(CanonicalJsonValue::Object(_))
    )
}

fn request_id(bytes: &[u8], max_nesting_depth: u16) -> Result<String, StdioTransportError> {
    let value = parse_core_json(
        bytes,
        ParseLimits::new(max_nesting_depth).map_err(|_| StdioTransportError::InvalidLimits)?,
    )
    .map_err(|_| StdioTransportError::InvalidFrame)?;
    let object = as_object(&value).ok_or(StdioTransportError::InvalidFrame)?;
    string_member(object, "id")
        .map(str::to_owned)
        .ok_or(StdioTransportError::RequestMismatch)
}

fn response_id(bytes: &[u8], max_nesting_depth: u16) -> Result<String, StdioTransportError> {
    request_id(bytes, max_nesting_depth)
}
fn complete_non_null_result(bytes: &[u8], max_nesting_depth: u16) -> bool {
    let Ok(limits) = ParseLimits::new(max_nesting_depth) else {
        return false;
    };
    let Ok(value) = parse_core_json(bytes, limits) else {
        return false;
    };
    let Some(object) = as_object(&value) else {
        return false;
    };
    if string_member(object, "jsonrpc") != Some("2.0") || object.get("error").is_some() {
        return false;
    }
    !matches!(object.get("result"), None | Some(CanonicalJsonValue::Null))
}

fn initialize_request() -> Result<Vec<u8>, StdioTransportError> {
    let value = serde_json::json!({
        "jsonrpc": "2.0",
        "id": INITIALIZE_REQUEST_ID,
        "method": "initialize",
        "params": {
            "protocolVersion": MCP_PROTOCOL_VERSION_2025_06_18,
            "capabilities": {},
            "clientInfo": {"name": "dolly", "version": "0.1.0"}
        }
    });
    canonicalize(&value)
        .map(|(bytes, _)| bytes.into_vec())
        .map_err(|_| StdioTransportError::InvalidFrame)
}

fn initialized_notification() -> Result<Vec<u8>, StdioTransportError> {
    let value = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    });
    canonicalize(&value)
        .map(|(bytes, _)| bytes.into_vec())
        .map_err(|_| StdioTransportError::InvalidFrame)
}

fn validate_initialize_response(
    bytes: &[u8],
    max_nesting_depth: u16,
) -> Result<(), StdioTransportError> {
    let value = parse_core_json(
        bytes,
        ParseLimits::new(max_nesting_depth).map_err(|_| StdioTransportError::InvalidLimits)?,
    )
    .map_err(|_| StdioTransportError::InvalidFrame)?;
    let object = as_object(&value).ok_or(StdioTransportError::InvalidFrame)?;
    if string_member(object, "jsonrpc") != Some("2.0")
        || string_member(object, "id") != Some(INITIALIZE_REQUEST_ID)
    {
        return Err(StdioTransportError::RequestMismatch);
    }
    let result = object
        .get("result")
        .and_then(as_object)
        .ok_or(StdioTransportError::InvalidFrame)?;
    if string_member(result, "protocolVersion") != Some(MCP_PROTOCOL_VERSION_2025_06_18) {
        return Err(StdioTransportError::InvalidFrame);
    }
    Ok(())
}

fn as_object(value: &CanonicalJsonValue) -> Option<&CanonicalJsonObject> {
    match value {
        CanonicalJsonValue::Object(object) => Some(object),
        _ => None,
    }
}

fn string_member<'a>(object: &'a CanonicalJsonObject, name: &str) -> Option<&'a str> {
    match object.get(name) {
        Some(CanonicalJsonValue::String(value)) => Some(value),
        _ => None,
    }
}

fn format_transport_error(error: StdioTransportError) -> String {
    match error {
        StdioTransportError::Readiness(detail) => format!("MCP readiness failed: {detail}"),
        StdioTransportError::InvalidLimits => "invalid transport limits".to_owned(),
        StdioTransportError::InvalidDeadline => "invalid operation deadline".to_owned(),
        StdioTransportError::MissingPipe => "stdio pipe is missing".to_owned(),
        StdioTransportError::ProcessIdentityMismatch => {
            "stdio process identity mismatch".to_owned()
        }
        StdioTransportError::InvalidFrame => "invalid MCP frame".to_owned(),
        StdioTransportError::FrameTooLarge => "MCP frame exceeds the configured limit".to_owned(),
        StdioTransportError::RequestMismatch => "MCP request correlation mismatch".to_owned(),
        StdioTransportError::NotInitialized => "MCP session is not initialized".to_owned(),
        StdioTransportError::AlreadyInitialized => "MCP session was already initialized".to_owned(),
        StdioTransportError::AlreadyUsed => "MCP transport already used".to_owned(),
        StdioTransportError::Cancelled => "MCP transport cancelled".to_owned(),
        StdioTransportError::Deadline => "MCP transport deadline exceeded".to_owned(),
        StdioTransportError::Disconnected => "MCP transport disconnected".to_owned(),
        StdioTransportError::Io => "MCP transport I/O failed".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;
    use std::process::{Command, Stdio};
    fn limits() -> StdioTransportLimits {
        StdioTransportLimits::new(1024, 16).expect("limits")
    }

    fn deadline_after(duration: Duration) -> Instant {
        Instant::now() + duration
    }

    fn session_with_handler<F>(handler: F) -> (McpStdioSession, thread::JoinHandle<()>)
    where
        F: FnOnce(&mut BufReader<UnixStream>, &mut UnixStream) + Send + 'static,
    {
        let (client, server) = UnixStream::pair().expect("socket pair");
        let client_reader = client.try_clone().expect("client reader");
        let server_reader = server.try_clone().expect("server reader");
        let session =
            McpStdioSession::from_parts(client_reader, client, ProcessControl::none(), limits());
        let thread = thread::spawn(move || {
            let mut reader = BufReader::new(server_reader);
            let mut writer = server;
            let mut line = String::new();
            reader.read_line(&mut line).expect("initialize request");
            assert!(line.contains("initialize"));
            writer
                .write_all(
                    b"{\"jsonrpc\":\"2.0\",\"id\":\"dolly-initialize\",\"result\":{\"protocolVersion\":\"2025-06-18\"}}\n",
                )
                .expect("initialize response");
            line.clear();
            reader
                .read_line(&mut line)
                .expect("initialized notification");
            assert!(line.contains("notifications/initialized"));
            handler(&mut reader, &mut writer);
        });
        (session, thread)
    }

    fn call_request() -> &'static [u8] {
        b"{\"jsonrpc\":\"2.0\",\"id\":\"call-1\",\"method\":\"tools/call\",\"params\":{}}"
    }
    #[cfg(target_os = "linux")]
    fn test_attestation(
        process_id: u32,
        executable_path: PathBuf,
        artifact_digest: Sha256Digest,
    ) -> HostMcpStdioInstalledChildAttestation {
        let endpoint = "bin/dolly-fs-tools".to_owned();
        let endpoint_digest = canonicalize(&CanonicalJsonValue::String(endpoint.clone()))
            .expect("endpoint digest")
            .1;
        HostMcpStdioInstalledChildAttestation {
            server_id: "fs".to_owned(),
            adapter: MCP_ADAPTER.to_owned(),
            protocol_version: MCP_PROTOCOL_VERSION_2025_06_18.to_owned(),
            transport_kind: MCP_STDIO_KIND.to_owned(),
            endpoint,
            endpoint_digest,
            package_digest: artifact_digest.clone(),
            package_path: executable_path.clone(),
            executable_digest: artifact_digest,
            executable_path,
            transport_digest:
                "sha256:2222222222222222222222222222222222222222222222222222222222222222"
                    .parse()
                    .expect("transport digest"),
            daemon_installation_id: "daemon-1".to_owned(),
            instance_id: "instance-1".to_owned(),
            controller_generation: ExtensionGeneration::new(1).expect("controller generation"),
            worker_epoch: "0198ab31-6c44-7e8a-b2bb-000000000001"
                .parse()
                .expect("worker epoch"),
            extension_alias: "org.dolly.tools".parse().expect("extension alias"),
            extension_generation: ExtensionGeneration::new(1).expect("extension generation"),
            runtime_binding_digest:
                "sha256:4444444444444444444444444444444444444444444444444444444444444444"
                    .parse()
                    .expect("runtime binding digest"),
            session_id: "session-1".to_owned(),
            process_id,
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn installed_child_verifier_binds_process_and_artifact_identity() {
        let first = Command::new("sleep")
            .arg("1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("first child");
        let first_path = std::fs::canonicalize(
            std::fs::read_link(format!("/proc/{}/exe", first.id())).expect("first executable"),
        )
        .expect("canonical first executable");
        let first_bytes = std::fs::read(&first_path).expect("first executable bytes");
        let attestation =
            test_attestation(first.id(), first_path, Sha256Digest::compute(&first_bytes));
        let mut issued =
            InstalledChildVerifier::issue(first, attestation.clone()).expect("verified child");
        issued.child.kill().expect("stop first child");
        issued.child.wait().expect("reap first child");

        let second = Command::new("sleep")
            .arg("0.1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("second child");
        assert!(
            InstalledChildVerifier::issue(second, attestation).is_err(),
            "copied claims cannot be paired with a different child"
        );
    }

    #[test]
    fn initialized_stdio_session_uses_exact_lifecycle_and_correlated_call() {
        let (mut session, server_thread) = session_with_handler(|reader, writer| {
            let mut line = String::new();
            reader.read_line(&mut line).expect("call request");
            assert!(line.contains("call-1"));
            writer
                .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"call-1\",\"result\":null}\n")
                .expect("call response");
        });
        let deadline = deadline_after(Duration::from_secs(1));
        session.initialize(deadline).expect("initialize");
        let response = session
            .exchange(call_request(), "call-1", deadline)
            .expect("response");
        assert_eq!(
            response,
            br#"{"jsonrpc":"2.0","id":"call-1","result":null}"#
        );
        server_thread.join().expect("server thread");
    }

    #[test]
    fn initialized_stdio_session_supports_a_second_correlated_call() {
        let (mut session, server_thread) = session_with_handler(|reader, writer| {
            let mut line = String::new();
            reader.read_line(&mut line).expect("first call request");
            assert!(line.contains("call-1"));
            writer
                .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"call-1\",\"result\":null}\n")
                .expect("first call response");
            line.clear();
            reader.read_line(&mut line).expect("second call request");
            assert!(line.contains("call-2"));
            writer
                .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"call-2\",\"result\":null}\n")
                .expect("second call response");
        });
        let deadline = deadline_after(Duration::from_secs(1));
        session.initialize(deadline).expect("initialize");
        session
            .exchange(call_request(), "call-1", deadline)
            .expect("first response");
        session
            .exchange(
                br#"{"jsonrpc":"2.0","id":"call-2","method":"tools/call","params":{}}"#,
                "call-2",
                deadline,
            )
            .expect("second response");
        server_thread.join().expect("server thread");
    }

    #[test]
    fn complete_absent_null_and_error_responses_remain_correlated() {
        for response in [
            br#"{"jsonrpc":"2.0","id":"call-1","result":null}"#.to_vec(),
            br#"{"jsonrpc":"2.0","id":"call-1","error":{"code":-1,"message":"no"}}"#.to_vec(),
            br#"{"jsonrpc":"2.0","id":"call-1"}"#.to_vec(),
        ] {
            let (mut session, server_thread) = session_with_handler(move |reader, writer| {
                let mut line = String::new();
                reader.read_line(&mut line).expect("call request");
                writer.write_all(&response).expect("response");
                writer.write_all(b"\n").expect("response delimiter");
            });
            let deadline = deadline_after(Duration::from_secs(1));
            session.initialize(deadline).expect("initialize");
            assert!(session.exchange(call_request(), "call-1", deadline).is_ok());
            server_thread.join().expect("server thread");
        }
    }

    #[test]
    fn mismatched_id_is_terminal_transport_error() {
        let (mut session, server_thread) = session_with_handler(|reader, writer| {
            let mut line = String::new();
            reader.read_line(&mut line).expect("call request");
            writer
                .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"other\",\"result\":null}\n")
                .expect("response");
        });
        let deadline = deadline_after(Duration::from_secs(1));
        session.initialize(deadline).expect("initialize");
        assert_eq!(
            session.exchange(call_request(), "call-1", deadline),
            Err(StdioTransportError::RequestMismatch)
        );
        server_thread.join().expect("server thread");
    }

    #[test]
    fn oversized_response_is_rejected_before_unbounded_allocation() {
        let (client, server) = UnixStream::pair().expect("socket pair");
        let client_reader = client.try_clone().expect("client reader");
        let server_reader = server.try_clone().expect("server reader");
        let mut session = McpStdioSession::from_parts(
            client_reader,
            client,
            ProcessControl::none(),
            StdioTransportLimits::new(256, 16).expect("limits"),
        );
        let server_thread = thread::spawn(move || {
            let mut reader = BufReader::new(server_reader);
            let mut writer = server;
            let mut line = String::new();
            reader.read_line(&mut line).expect("initialize");
            writer
                .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"dolly-initialize\",\"result\":{\"protocolVersion\":\"2025-06-18\"}}\n")
                .expect("initialize response");
            line.clear();
            reader.read_line(&mut line).expect("notification");
            line.clear();
            reader.read_line(&mut line).expect("call");
            writer
                .write_all(
                    format!(
                        "{{\"jsonrpc\":\"2.0\",\"id\":\"call-1\",\"result\":\"{}\"}}\n",
                        "x".repeat(512)
                    )
                    .as_bytes(),
                )
                .expect("oversized response");
        });
        let deadline = deadline_after(Duration::from_secs(1));
        session.initialize(deadline).expect("initialize");
        assert_eq!(
            session.exchange(call_request(), "call-1", deadline),
            Err(StdioTransportError::InvalidFrame)
        );
        server_thread.join().expect("server thread");
    }

    #[test]
    fn deadline_and_cancellation_never_wait_unbounded() {
        let (mut session, server_thread) = session_with_handler(|reader, _writer| {
            let mut line = String::new();
            reader.read_line(&mut line).expect("call request");
            thread::sleep(Duration::from_millis(150));
        });
        let initialize_deadline = deadline_after(Duration::from_secs(1));
        session.initialize(initialize_deadline).expect("initialize");
        assert_eq!(
            session.exchange(
                call_request(),
                "call-1",
                deadline_after(Duration::from_millis(40)),
            ),
            Err(StdioTransportError::Deadline)
        );
        server_thread.join().expect("server thread");

        let (mut session, server_thread) = session_with_handler(|reader, _writer| {
            let mut line = String::new();
            reader.read_line(&mut line).expect("call request");
            thread::sleep(Duration::from_millis(150));
        });
        let initialize_deadline = deadline_after(Duration::from_secs(1));
        session.initialize(initialize_deadline).expect("initialize");
        let cancellation = session.cancellation();
        let call_deadline = deadline_after(Duration::from_secs(1));
        let call = thread::spawn(move || session.exchange(call_request(), "call-1", call_deadline));
        thread::sleep(Duration::from_millis(20));
        cancellation.cancel();
        assert_eq!(
            call.join().expect("call thread"),
            Err(StdioTransportError::Cancelled)
        );
        server_thread.join().expect("server thread");
    }

    #[test]
    fn transport_enforces_request_identity_and_no_redispatch() {
        let (mut session, server_thread) = session_with_handler(|reader, _writer| {
            reader
                .get_mut()
                .set_read_timeout(Some(Duration::from_millis(100)))
                .expect("read timeout");
            let mut line = String::new();
            let error = reader.read_line(&mut line).expect_err("no call request");
            assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
        });
        let deadline = deadline_after(Duration::from_secs(1));
        session.initialize(deadline).expect("initialize");
        let mut transport = McpStdioTransport::test(session, "call-1", deadline);
        assert!(matches!(
            transport.call(br#"{"jsonrpc":"2.0","id":"wrong","method":"tools/call","params":{}}"#),
            TransportOutcome::Error(_)
        ));
        assert!(matches!(
            transport.call(call_request()),
            TransportOutcome::Error(_)
        ));
        drop(transport);
        server_thread.join().expect("server thread");
    }
    #[test]
    fn absent_null_and_error_are_unknown_transport_outcomes() {
        for response in [
            br#"{"jsonrpc":"2.0","id":"call-1"}"#.to_vec(),
            br#"{"jsonrpc":"2.0","id":"call-1","result":null}"#.to_vec(),
            br#"{"jsonrpc":"2.0","id":"call-1","error":{"code":-1,"message":"no"}}"#.to_vec(),
        ] {
            let (mut session, server_thread) = session_with_handler(move |reader, writer| {
                let mut line = String::new();
                reader.read_line(&mut line).expect("call request");
                writer.write_all(&response).expect("response");
                writer.write_all(b"\n").expect("response delimiter");
            });
            let deadline = deadline_after(Duration::from_secs(1));
            session.initialize(deadline).expect("initialize");
            let mut transport = McpStdioTransport::test(session, "call-1", deadline);
            assert!(matches!(
                transport.call(call_request()),
                TransportOutcome::Error(_)
            ));
            server_thread.join().expect("server thread");
        }
    }
    #[test]
    fn authorized_deadline_is_absolute_and_malformed_deadlines_refuse() {
        let before = Instant::now();

        let deadline = absolute_deadline("2099-01-01T00:00:00.000000Z").expect("future deadline");
        assert!(deadline > before);
        assert_eq!(
            absolute_deadline("not-a-deadline"),
            Err(StdioTransportError::InvalidDeadline)
        );
    }
    #[test]
    fn normal_session_drop_does_not_terminate_host_process() {
        let mut child = Command::new("sleep")
            .arg("2")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("sleep child");
        let reader = child.stdout.take().expect("stdout");
        let writer = child.stdin.take().expect("stdin");
        let process = ProcessControl::child(child);
        let session = McpStdioSession::from_parts(reader, writer, process.clone(), limits());
        drop(session);
        let mut child = process
            .child
            .as_ref()
            .expect("child")
            .lock()
            .expect("child lock");
        assert!(child.try_wait().expect("try wait").is_none());
        let _ = child.kill();
        let _ = child.wait();
    }
}
