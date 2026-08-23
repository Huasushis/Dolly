#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use dolly_canonical_json::{
    CanonicalJsonObject, CanonicalJsonValue, PROTOCOL_WIRE_PARSE_DEPTH, ParseLimits, Sha256Digest,
    canonicalize, parse_core_json,
};
use dolly_core_domain::{ExtensionGeneration, ExtensionId, WorkerEpoch};
use dolly_storage::mcp_readiness::{
    MCP_PROTOCOL_VERSION_2025_06_18, McpHandshakeObservation, McpTransportBinding,
    McpTransportProbe, McpTransportProbeError, McpTransportReadiness,
};
use dolly_storage::tool_broker_authority::ToolDispatchAuthority;

use crate::permit::SendPermitBinding;
use crate::service::{ToolTransport, TransportOutcome};

const INITIALIZE_REQUEST_ID: &str = "dolly-initialize";
const MCP_ADAPTER: &str = "mcp";
const MCP_STDIO_KIND: &str = "stdio";

/// Bounds applied to every stdio application frame and exchange.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StdioTransportLimits {
    pub(crate) max_frame_bytes: usize,
    pub(crate) max_nesting_depth: u16,
    pub(crate) request_timeout: Duration,
}

impl StdioTransportLimits {
    pub(crate) fn new(
        max_frame_bytes: usize,
        max_nesting_depth: u16,
        request_timeout: Duration,
    ) -> Result<Self, StdioTransportError> {
        if max_frame_bytes < 2
            || max_nesting_depth == 0
            || max_nesting_depth > PROTOCOL_WIRE_PARSE_DEPTH
            || request_timeout.is_zero()
        {
            return Err(StdioTransportError::InvalidLimits);
        }
        Ok(Self {
            max_frame_bytes,
            max_nesting_depth,
            request_timeout,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StdioTransportError {
    InvalidLimits,
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
}

impl StdioCancellation {
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

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

#[derive(Debug)]
enum ReaderEvent {
    Frame(Vec<u8>),
    ProtocolError,
    Eof,
    Io,
}

/// One initialized stdio session. The Host supplies the already-started,
/// digest-pinned child; this object owns only the bounded I/O seam.
pub(crate) struct McpStdioSession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    events: mpsc::Receiver<ReaderEvent>,
    process: Arc<ProcessControl>,
    cancellation: StdioCancellation,
    limits: StdioTransportLimits,
    initialized: bool,
}

impl McpStdioSession {
    pub(crate) fn from_child(
        mut child: Child,
        limits: StdioTransportLimits,
    ) -> Result<Self, StdioTransportError> {
        let stdin = child.stdin.take().ok_or(StdioTransportError::MissingPipe)?;
        let stdout = child
            .stdout
            .take()
            .ok_or(StdioTransportError::MissingPipe)?;
        Ok(Self::from_parts(
            stdout,
            stdin,
            ProcessControl::child(child),
            limits,
        ))
    }
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
            process,
            cancellation,
            limits,
            initialized: false,
        }
    }

    pub(crate) fn cancellation(&self) -> StdioCancellation {
        self.cancellation.clone()
    }

    pub(crate) fn initialize(&mut self) -> Result<(), StdioTransportError> {
        if self.initialized {
            return Err(StdioTransportError::AlreadyInitialized);
        }
        let request = initialize_request()?;
        let response = self.exchange(&request, INITIALIZE_REQUEST_ID)?;
        if let Err(error) = validate_initialize_response(&response, self.limits.max_nesting_depth) {
            self.abort();
            return Err(error);
        }
        let notification = initialized_notification()?;
        self.send_frame(&notification, Instant::now() + self.limits.request_timeout)?;
        self.initialized = true;
        Ok(())
    }

    fn exchange(
        &mut self,
        request_bytes: &[u8],
        expected_request_id: &str,
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
        let deadline = Instant::now() + self.limits.request_timeout;
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
        self.process.stop();
    }
}

impl Drop for McpStdioSession {
    fn drop(&mut self) {
        self.abort();
    }
}

/// Identity of the already-started, digest-pinned Host child process.
pub(crate) struct McpStdioProcessIdentity {
    pub(crate) daemon_installation_id: String,
    pub(crate) instance_id: String,
    pub(crate) controller_generation: ExtensionGeneration,
    pub(crate) worker_epoch: WorkerEpoch,
    pub(crate) extension_alias: ExtensionId,
    pub(crate) extension_generation: ExtensionGeneration,
    pub(crate) runtime_binding_digest: Sha256Digest,
    pub(crate) session_id: String,
    pub(crate) package_digest: Sha256Digest,
    pub(crate) executable_digest: Sha256Digest,
}

/// MCP stdio probe and initialized-session owner. It performs the exact v1
/// initialize/initialized lifecycle and returns only readiness observation.
pub(crate) struct McpStdioProbe {
    session: Option<McpStdioSession>,
    identity: McpStdioProcessIdentity,
    observed: bool,
}

impl McpStdioProbe {
    pub(crate) fn from_child(
        child: Child,
        identity: McpStdioProcessIdentity,
        limits: StdioTransportLimits,
    ) -> Result<Self, StdioTransportError> {
        let session = McpStdioSession::from_child(child, limits)?;
        if identity.session_id.is_empty() || identity.session_id.len() > 512 {
            return Err(StdioTransportError::ProcessIdentityMismatch);
        }
        Ok(Self {
            session: Some(session),
            identity,
            observed: false,
        })
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
            server_id: permit.tool_server_id.clone(),
            server_generation: permit.tool_server_generation,
            config_revision: permit.config_revision,
            readiness_digest: readiness.readiness_digest().clone(),
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
        {
            return Err(McpTransportProbeError::Unsupported(
                "only MCP 2025-06-18 stdio is implemented".to_owned(),
            ));
        }
        if !stdio_digests_match(binding, &self.identity) {
            return Err(McpTransportProbeError::Failed(
                "installed child digest does not match the configured stdio transport".to_owned(),
            ));
        }
        self.session
            .as_mut()
            .ok_or_else(|| {
                McpTransportProbeError::Ambiguous("stdio session is consumed".to_owned())
            })?
            .initialize()
            .map_err(|_| {
                McpTransportProbeError::Failed("MCP initialize lifecycle failed".to_owned())
            })?;
        self.observed = true;
        Ok(McpHandshakeObservation {
            server_id: Some(binding.server_id().to_owned()),
            adapter: Some(binding.adapter().to_owned()),
            daemon_installation_id: Some(self.identity.daemon_installation_id.clone()),
            instance_id: Some(self.identity.instance_id.clone()),
            controller_generation: Some(self.identity.controller_generation),
            worker_epoch: Some(self.identity.worker_epoch.clone()),
            extension_alias: Some(self.identity.extension_alias.clone()),
            extension_generation: Some(self.identity.extension_generation),
            runtime_binding_digest: Some(self.identity.runtime_binding_digest.clone()),
            transport_kind: Some(binding.transport_kind().to_owned()),
            endpoint: Some(binding.endpoint().to_owned()),
            transport_digest: Some(binding.transport_digest().clone()),
            initialize_request_protocol_version: Some(MCP_PROTOCOL_VERSION_2025_06_18.to_owned()),
            initialize_response_protocol_version: Some(MCP_PROTOCOL_VERSION_2025_06_18.to_owned()),
            initialized_notification_sent: true,
            session_ids: vec![self.identity.session_id.clone()],
        })
    }
}

/// One-use stdio tools/call transport. Authority is checked before it is
/// constructed; the transport then enforces exact request identity and one
/// call per permit.
pub(crate) struct McpStdioTransport {
    session: McpStdioSession,
    expected_request_id: String,
    server_id: String,
    server_generation: u64,
    config_revision: i64,
    readiness_digest: Sha256Digest,
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
    fn test(session: McpStdioSession, request_id: &str) -> Self {
        Self {
            session,
            expected_request_id: request_id.to_owned(),
            server_id: "test-server".to_owned(),
            server_generation: 1,
            config_revision: 1,
            readiness_digest: Sha256Digest::compute(b"test-readiness"),
            used: false,
        }
    }

    #[cfg(test)]
    fn identity(&self) -> (&str, u64, i64, &Sha256Digest) {
        (
            &self.server_id,
            self.server_generation,
            self.config_revision,
            &self.readiness_digest,
        )
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
            .exchange(request_bytes, &self.expected_request_id)
        {
            Ok(response) => {
                if complete_non_null_result(&response, self.session.limits.max_nesting_depth) {
                    TransportOutcome::Response(response)
                } else {
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

fn stdio_digests_match(binding: &McpTransportBinding, identity: &McpStdioProcessIdentity) -> bool {
    let transport = binding.transport();
    string_member(transport, "package_digest").and_then(|value| value.parse::<Sha256Digest>().ok())
        == Some(identity.package_digest.clone())
        && string_member(transport, "executable_digest")
            .and_then(|value| value.parse::<Sha256Digest>().ok())
            == Some(identity.executable_digest.clone())
}

fn format_transport_error(error: StdioTransportError) -> String {
    match error {
        StdioTransportError::InvalidLimits => "invalid transport limits",
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

    fn limits(timeout: Duration) -> StdioTransportLimits {
        StdioTransportLimits::new(1024, 16, timeout).expect("limits")
    }

    fn session_with_handler<F>(
        timeout: Duration,
        handler: F,
    ) -> (McpStdioSession, thread::JoinHandle<()>)
    where
        F: FnOnce(&mut BufReader<UnixStream>, &mut UnixStream) + Send + 'static,
    {
        let (client, server) = UnixStream::pair().expect("socket pair");
        let client_reader = client.try_clone().expect("client reader");
        let server_reader = server.try_clone().expect("server reader");
        let session = McpStdioSession::from_parts(
            client_reader,
            client,
            ProcessControl::none(),
            limits(timeout),
        );
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
        let (mut session, server_thread) =
            session_with_handler(Duration::from_secs(1), |reader, writer| {
                let mut line = String::new();
                reader.read_line(&mut line).expect("call request");
                assert!(line.contains("call-1"));
                writer
                    .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"call-1\",\"result\":null}\n")
                    .expect("call response");
            });
        session.initialize().expect("initialize");
        let response = session
            .exchange(call_request(), "call-1")
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
            let (mut session, server_thread) =
                session_with_handler(Duration::from_secs(1), move |reader, writer| {
                    let mut line = String::new();
                    reader.read_line(&mut line).expect("call request");
                    writer.write_all(&response).expect("response");
                    writer.write_all(b"\n").expect("response delimiter");
                });
            session.initialize().expect("initialize");
            assert!(session.exchange(call_request(), "call-1").is_ok());
            server_thread.join().expect("server thread");
        }
    }

    #[test]
    fn mismatched_id_is_terminal_transport_error() {
        let (mut session, server_thread) =
            session_with_handler(Duration::from_secs(1), |reader, writer| {
                let mut line = String::new();
                reader.read_line(&mut line).expect("call request");
                writer
                    .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"other\",\"result\":null}\n")
                    .expect("response");
            });
        session.initialize().expect("initialize");
        assert_eq!(
            session.exchange(call_request(), "call-1"),
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
            StdioTransportLimits::new(256, 16, Duration::from_secs(1)).expect("limits"),
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
        session.initialize().expect("initialize");
        assert_eq!(
            session.exchange(call_request(), "call-1"),
            Err(StdioTransportError::InvalidFrame)
        );
        server_thread.join().expect("server thread");
    }

    #[test]
    fn deadline_and_cancellation_never_wait_unbounded() {
        let (mut session, server_thread) =
            session_with_handler(Duration::from_millis(40), |reader, _writer| {
                let mut line = String::new();
                reader.read_line(&mut line).expect("call request");
                thread::sleep(Duration::from_millis(150));
            });
        session.initialize().expect("initialize");
        assert_eq!(
            session.exchange(call_request(), "call-1"),
            Err(StdioTransportError::Deadline)
        );
        server_thread.join().expect("server thread");

        let (mut session, server_thread) =
            session_with_handler(Duration::from_secs(1), |reader, _writer| {
                let mut line = String::new();
                reader.read_line(&mut line).expect("call request");
                thread::sleep(Duration::from_millis(150));
            });
        session.initialize().expect("initialize");
        let cancellation = session.cancellation();
        let call = thread::spawn(move || session.exchange(call_request(), "call-1"));
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
        let (mut session, server_thread) =
            session_with_handler(Duration::from_secs(1), |reader, writer| {
                let mut line = String::new();
                reader.read_line(&mut line).expect("call request");
                writer
                    .write_all(
                        b"{\"jsonrpc\":\"2.0\",\"id\":\"call-1\",\"result\":{\"ok\":true}}\n",
                    )
                    .expect("response");
            });
        session.initialize().expect("initialize");
        let mut transport = McpStdioTransport::test(session, "call-1");
        assert_eq!(transport.identity().0, "test-server");
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
            let (mut session, server_thread) =
                session_with_handler(Duration::from_secs(1), move |reader, writer| {
                    let mut line = String::new();
                    reader.read_line(&mut line).expect("call request");
                    writer.write_all(&response).expect("response");
                    writer.write_all(b"\n").expect("response delimiter");
                });
            session.initialize().expect("initialize");
            let mut transport = McpStdioTransport::test(session, "call-1");
            assert!(matches!(
                transport.call(call_request()),
                TransportOutcome::Error(_)
            ));
            server_thread.join().expect("server thread");
        }
    }
}
