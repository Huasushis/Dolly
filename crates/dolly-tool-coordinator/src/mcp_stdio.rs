#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
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
pub(crate) struct StdioTransportLimits {
    pub(crate) max_frame_bytes: usize,
    pub(crate) max_nesting_depth: u16,
}

impl StdioTransportLimits {
    pub(crate) fn new(
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
pub(crate) enum StdioTransportError {
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
pub(crate) struct HostMcpStdioProcessHandle {
    process: Arc<ProcessControl>,
    identity: HostVerifiedMcpStdioIdentity,
}

impl HostMcpStdioProcessHandle {
    pub(crate) fn terminate(&self) {
        self.process.stop();
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
    /// The Host calls this only after its installed-child verifier has
    /// authenticated the exact executable/package digests for `binding`.
    pub(crate) fn from_verified_child(
        mut child: Child,
        binding: &McpTransportBinding,
        process_generation: &ProcessGeneration,
    ) -> Result<Self, StdioTransportError> {
        let reader = child
            .stdout
            .take()
            .ok_or(StdioTransportError::MissingPipe)?;
        let writer = child.stdin.take().ok_or(StdioTransportError::MissingPipe)?;
        let process = ProcessControl::child(child);
        let identity = HostVerifiedMcpStdioIdentity {
            server_id: binding.server_id().to_owned(),
            adapter: binding.adapter().to_owned(),
            protocol_version: binding.protocol_version().to_owned(),
            transport_kind: binding.transport_kind().to_owned(),
            endpoint: binding.endpoint().to_owned(),
            endpoint_digest: binding.endpoint_digest().clone(),
            transport_digest: binding.transport_digest().clone(),
            daemon_installation_id: process_generation.daemon_installation_id().to_owned(),
            instance_id: process_generation.instance_id().to_owned(),
            controller_generation: process_generation.controller_generation(),
            worker_epoch: process_generation.worker_epoch().clone(),
            extension_alias: process_generation.extension_alias().clone(),
            extension_generation: process_generation.extension_generation(),
            runtime_binding_digest: process_generation.binding_digest().clone(),
            session_id: stdio_session_id(binding, process_generation, process.as_ref()),
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

fn stdio_session_id(
    binding: &McpTransportBinding,
    process_generation: &ProcessGeneration,
    process: &ProcessControl,
) -> String {
    let process_identity = process
        .child
        .as_ref()
        .and_then(|child| child.lock().ok().map(|child| child.id()))
        .unwrap_or_default();
    Sha256Digest::compute(
        format!(
            "dolly-mcp-stdio/v1/{}/{}/{}",
            binding.server_id(),
            process_generation.binding_digest(),
            process_identity
        )
        .as_bytes(),
    )
    .to_string()
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

/// The production probe is created only from a Host-owned verified session.
pub(crate) struct McpStdioProbe {
    session: Option<McpStdioSession>,
    identity: HostVerifiedMcpStdioIdentity,
    deadline: Instant,
    observed: bool,
}

impl McpStdioProbe {
    pub(crate) fn from_host_session(
        host_session: HostOwnedMcpStdioSession,
        limits: StdioTransportLimits,
        deadline: Instant,
    ) -> Self {
        let identity = host_session.handle.identity.clone();
        let (reader, writer, process) = host_session.into_parts();
        Self {
            session: Some(McpStdioSession::from_parts(reader, writer, process, limits)),
            identity,
            deadline,
            observed: false,
        }
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
            return Err(StdioTransportError::ProcessIdentityMismatch);
        }
        if !self.observed {
            return Err(StdioTransportError::NotInitialized);
        }
        Ok(McpStdioTransport {
            session: self
                .session
                .take()
                .ok_or(StdioTransportError::NotInitialized)?,
            expected_request_id: permit.server_request_id.clone(),
            deadline: self.deadline,
            used: false,
        })
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
    identity.server_id == binding.server_id()
        && identity.adapter == binding.adapter()
        && identity.protocol_version == binding.protocol_version()
        && identity.transport_kind == binding.transport_kind()
        && identity.endpoint == binding.endpoint()
        && identity.endpoint_digest == *binding.endpoint_digest()
        && identity.transport_digest == *binding.transport_digest()
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
    expected_request_id: String,
    deadline: Instant,
    used: bool,
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
        Self {
            session,
            expected_request_id: request_id.to_owned(),
            deadline,
            used: false,
        }
    }
}
impl ToolTransport for McpStdioTransport {
    fn call(&mut self, request_bytes: &[u8]) -> TransportOutcome {
        if !self.session.initialized {
            return TransportOutcome::Error(format_transport_error(
                StdioTransportError::NotInitialized,
            ));
        }
        if self.used {
            return TransportOutcome::Error(format_transport_error(
                StdioTransportError::AlreadyUsed,
            ));
        }
        if let Err(error) = self.validate_request(request_bytes) {
            return TransportOutcome::Error(format_transport_error(error));
        }
        self.used = true;
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
            Err(StdioTransportError::Deadline) => TransportOutcome::Timeout,
            Err(error) => TransportOutcome::Error(format_transport_error(error)),
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
        StdioTransportError::InvalidLimits => "invalid transport limits",
        StdioTransportError::InvalidDeadline => "invalid operation deadline",
        StdioTransportError::MissingPipe => "stdio pipe is missing",
        StdioTransportError::ProcessIdentityMismatch => "stdio process identity mismatch",
        StdioTransportError::InvalidFrame => "invalid MCP frame",
        StdioTransportError::FrameTooLarge => "MCP frame exceeds the configured limit",
        StdioTransportError::RequestMismatch => "MCP request correlation mismatch",
        StdioTransportError::NotInitialized => "MCP session is not initialized",
        StdioTransportError::AlreadyInitialized => "MCP session was already initialized",
        StdioTransportError::AlreadyUsed => "MCP transport already used",
        StdioTransportError::Cancelled => "MCP transport cancelled",
        StdioTransportError::Deadline => "MCP transport deadline exceeded",
        StdioTransportError::Disconnected => "MCP transport disconnected",
        StdioTransportError::Io => "MCP transport I/O failed",
    }
    .to_owned()
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
        let (mut session, server_thread) = session_with_handler(|reader, writer| {
            let mut line = String::new();
            reader.read_line(&mut line).expect("call request");
            writer
                .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"call-1\",\"result\":{\"ok\":true}}\n")
                .expect("response");
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
            TransportOutcome::Response(_)
        ));
        assert!(matches!(
            transport.call(call_request()),
            TransportOutcome::Error(_)
        ));
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
