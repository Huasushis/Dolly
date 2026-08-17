//! Connection-level wire protocol state: frame codec driving, JSON-RPC 2.0
//! envelope decoding, and initialize-first ordering.
//!
//! The connection owns a [`FrameReader`] and decodes each completed frame
//! payload with [`crate::message::decode_message`]. The first accepted
//! request must be `extension.initialize`; until then the connection stays in
//! [`ConnectionState::PreInitialization`]. Any fatal framing or message
//! violation latches the connection into [`ConnectionState::Closed`] and no
//! further bytes are accepted.

use std::fmt;

use crate::frame::{FrameError, FrameLimits, FrameReader};
use crate::message::{DecodedMessage, MessageError, decode_message};

/// Lifecycle state of one protocol connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionState {
    /// No `extension.initialize` request has been accepted yet.
    PreInitialization,
    /// The handshake request has been accepted; the connection is usable.
    Ready,
    /// A fatal framing or message violation closed the connection.
    Closed,
}

/// Events emitted by the connection, observable by the host before the
/// transport is closed.
#[derive(Clone, Debug, PartialEq)]
pub enum ConnectionEvent {
    /// A JSON-RPC transport error (`-32700` parse error or `-32600` invalid
    /// request) emitted before closing on a message violation.
    TransportError { code: i32 },
}

/// The concrete violation that closed a connection.
#[derive(Clone, Debug, PartialEq)]
pub struct ProtocolViolation {
    pub kind: ViolationKind,
}

/// Classification of a fatal violation.
#[derive(Clone, Debug, PartialEq)]
pub enum ViolationKind {
    /// A fatal framing violation from [`FrameReader`].
    Framing(FrameError),
    /// A fatal message (payload) violation from envelope validation.
    Message(MessageError),
}

impl ViolationKind {
    /// Whether closing on this violation emits a JSON-RPC transport error
    /// before closing the transport. Framing violations and frame-too-deep
    /// rejections emit nothing; parse and invalid-request rejections emit a
    /// transport error (TST-PROTO-001 emits `-32700`, TST-PROTO-002 emits
    /// nothing).
    pub fn emits_transport_error(&self) -> bool {
        match self {
            ViolationKind::Framing(_) => false,
            ViolationKind::Message(err) => err.emits_transport_error(),
        }
    }
}

impl fmt::Display for ViolationKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ViolationKind::Framing(err) => write!(f, "framing violation: {err}"),
            ViolationKind::Message(err) => write!(f, "message violation: {err}"),
        }
    }
}

impl std::error::Error for ViolationKind {}

/// A bounded protocol connection. Drives the frame codec, decodes JSON-RPC 2.0
/// envelopes, and enforces initialize-first ordering.
#[derive(Debug)]
pub struct Connection {
    limits: FrameLimits,
    reader: FrameReader,
    state: ConnectionState,
    method_invocations: Vec<String>,
    events: Vec<ConnectionEvent>,
    violation: Option<ProtocolViolation>,
    terminated: bool,
}

impl Connection {
    /// Creates a new connection in [`ConnectionState::PreInitialization`].
    pub fn new(limits: FrameLimits) -> Self {
        Self {
            limits,
            reader: FrameReader::new(limits),
            state: ConnectionState::PreInitialization,
            method_invocations: Vec::new(),
            events: Vec::new(),
            violation: None,
            terminated: false,
        }
    }

    /// Current lifecycle state.
    pub fn state(&self) -> ConnectionState {
        self.state
    }

    /// Whether the connection is closed by a fatal violation.
    pub fn is_terminated(&self) -> bool {
        self.terminated
    }

    /// Whether the connection has completed initialization and is usable.
    pub fn is_ready(&self) -> bool {
        self.state == ConnectionState::Ready
    }

    /// Method names of the requests and notifications accepted so far, in
    /// acceptance order.
    pub fn method_invocations(&self) -> &[String] {
        &self.method_invocations
    }

    /// Events emitted so far, in emission order.
    pub fn events(&self) -> &[ConnectionEvent] {
        &self.events
    }

    /// The violation that closed the connection, if any.
    pub fn violation(&self) -> Option<&ProtocolViolation> {
        self.violation.as_ref()
    }

    /// Feeds transport bytes, decoding every frame completed by this call.
    /// Returns `Err` on the first fatal framing or message violation; the
    /// connection is then latched and every further call returns the same
    /// violation.
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<DecodedMessage>, ProtocolViolation> {
        if self.terminated {
            return Err(self
                .violation
                .clone()
                .expect("terminated connection has a violation"));
        }
        let frames = self.reader.feed(bytes).map_err(|err| {
            self.close(ViolationKind::Framing(err));
            self.violation
                .clone()
                .expect("violation set on framing close")
        })?;

        let mut messages = Vec::with_capacity(frames.len());
        for payload in frames {
            let message = match decode_message(&payload, self.limits) {
                Ok(message) => message,
                Err(err) => {
                    if err.emits_transport_error() {
                        if let Some(code) = err.transport_error_code() {
                            self.events.push(ConnectionEvent::TransportError { code });
                        }
                    }
                    let kind = ViolationKind::Message(err);
                    self.close(kind);
                    return Err(self
                        .violation
                        .clone()
                        .expect("violation set on message close"));
                }
            };
            if let Err(err) = self.accept(&message) {
                if err.emits_transport_error() {
                    if let Some(code) = err.transport_error_code() {
                        self.events.push(ConnectionEvent::TransportError { code });
                    }
                }
                self.close(ViolationKind::Message(err));
                return Err(self
                    .violation
                    .clone()
                    .expect("violation set on init-first close"));
            }
            messages.push(message);
        }
        Ok(messages)
    }

    /// Signals end of stream. A partial frame in the reader becomes a fatal
    /// framing violation.
    pub fn finish(mut self) -> Result<(), ProtocolViolation> {
        if self.terminated {
            return Err(self
                .violation
                .clone()
                .expect("terminated connection has a violation"));
        }
        let reader = std::mem::replace(&mut self.reader, FrameReader::new(self.limits));
        match reader.finish() {
            Ok(()) => Ok(()),
            Err(err) => {
                self.close(ViolationKind::Framing(err));
                Err(self
                    .violation
                    .clone()
                    .expect("violation set on finish close"))
            }
        }
    }

    fn close(&mut self, kind: ViolationKind) {
        if self.terminated {
            return;
        }
        self.state = ConnectionState::Closed;
        self.terminated = true;
        self.violation = Some(ProtocolViolation { kind });
    }
    fn accept(&mut self, message: &DecodedMessage) -> Result<(), MessageError> {
        match self.state {
            ConnectionState::PreInitialization => {
                if message.kind == crate::message::MessageKind::Request
                    && message.method() == Some("extension.initialize")
                {
                    self.state = ConnectionState::Ready;
                } else {
                    return Err(MessageError::InvalidRequest {
                        reason: "first request must be extension.initialize".into(),
                    });
                }
            }
            ConnectionState::Ready | ConnectionState::Closed => {}
        }
        if let Some(method) = message.method() {
            self.method_invocations.push(method.to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{FrameLimits, encode_frame};

    fn init_frame() -> Vec<u8> {
        encode_frame(br#"{"jsonrpc":"2.0","id":"i","method":"extension.initialize","params":{}}"#)
    }

    #[test]
    fn starts_pre_initialization() {
        let connection = Connection::new(FrameLimits::defaults());
        assert_eq!(connection.state(), ConnectionState::PreInitialization);
        assert!(!connection.is_ready());
    }

    #[test]
    fn initialize_transitions_to_ready() {
        let mut connection = Connection::new(FrameLimits::defaults());
        connection.feed(&init_frame()).unwrap();
        assert_eq!(connection.state(), ConnectionState::Ready);
        assert!(connection.is_ready());
        assert_eq!(
            connection.method_invocations(),
            &["extension.initialize".to_string()]
        );
    }

    #[test]
    fn duplicate_key_emits_transport_error_and_closes() {
        let mut connection = Connection::new(FrameLimits::defaults());
        connection.feed(&init_frame()).unwrap();
        let frame =
            encode_frame(br#"{"jsonrpc":"2.0","id":"a","id":"b","method":"extension.ping"}"#);
        let err = connection.feed(&frame).unwrap_err();
        assert!(matches!(
            err.kind,
            ViolationKind::Message(MessageError::Parse { .. })
        ));
        assert_eq!(connection.state(), ConnectionState::Closed);
        assert!(connection.is_terminated());
        assert_eq!(
            connection.events(),
            &[ConnectionEvent::TransportError { code: -32700 }]
        );
    }

    #[test]
    fn frame_too_deep_closes_without_transport_error() {
        let mut connection = Connection::new(FrameLimits::defaults());
        connection.feed(&init_frame()).unwrap();
        let mut text = String::new();
        for _ in 0..97 {
            text.push('[');
        }
        text.push('0');
        for _ in 0..97 {
            text.push(']');
        }
        let frame = encode_frame(text.as_bytes());
        let err = connection.feed(&frame).unwrap_err();
        assert!(matches!(
            err.kind,
            ViolationKind::Message(MessageError::FrameTooDeep {
                limit: 96,
                found: 97
            })
        ));
        assert!(connection.is_terminated());
        assert!(connection.events().is_empty());
    }
}
