//! Fail-closed injected transport seam for the Channel.
//!
//! The Channel never speaks to a real transport. Delivery goes through the
//! [`ChannelTransport`] seam, which is injected by the caller (a test double,
//! a recorded driver, or a production adapter). The seam communicates exactly
//! the outcome classes the specification requires: confirmed pieces with
//! transport message IDs, rejected pieces, and `Unknown` for timeouts or
//! losses after bytes may have reached the transport.

/// One outbound piece handed to the transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportPiece {
    pub ordinal: u32,
    pub text: String,
}

/// The transport-facing send request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportSendRequest {
    pub action_id: String,
    /// Stable derivation of `action_id`, present only when the transport
    /// supports provider-side idempotency keys.
    pub idempotency_key: Option<String>,
    pub session_id: String,
    pub pieces: Vec<TransportPiece>,
}

/// The outcome of one piece.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportPieceOutcome {
    Confirmed {
        ordinal: u32,
        message_id: String,
    },
    Rejected {
        ordinal: u32,
        code: String,
    },
    /// Unknown: the request may have reached the transport.
    Unknown {
        ordinal: u32,
    },
}


/// The closed result of one `send` call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportSendResult {
    /// All pieces confirmed; `message_ids[ordinal]` is the transport ID.
    AllConfirmed { message_ids: Vec<String> },
    /// Per-piece outcomes (one per piece, in ordinal order). A piece may be
    /// Confirmed, Rejected, or Unknown (timeout).
    PerPiece { pieces: Vec<TransportPieceOutcome> },
    /// Whole-call timeout: bytes may have reached the transport; nothing is
    /// confidently failed.
    Timeout,
    /// Whole-call rejection by the transport (authentication, rate limit,
    /// shutdown, ...). Nothing is known to have been delivered.
    Rejected { code: String },
}

/// The transport-facing capability and delivery seam.
pub trait ChannelTransport {
    /// Whether the transport accepts and honors a provider-side idempotency
    /// key. When `false`, the Channel MUST persist `dispatched` before or
    /// atomically with send initiation.
    fn idempotency_supported(&self) -> bool;
    /// Deliver one send request. The result is the only observation input to
    /// ledger reconciliation; the Channel never guesses.
    fn send(&mut self, request: &TransportSendRequest) -> TransportSendResult;
}

/// A deterministic scripted transport for tests and recorded drivers.
///
/// Scripts are consumed in order; a send past the end of the script fails
/// closed with `Timeout` (matching the specification's bias toward `unknown`
/// over a fabricated failure).
#[derive(Debug, Clone, Default)]
pub struct ScriptedTransport {
    idempotency_supported: bool,
    script: Vec<TransportSendResult>,
    calls: Vec<TransportSendRequest>,
}

impl ScriptedTransport {
    pub fn new(idempotency_supported: bool) -> Self {
        Self {
            idempotency_supported,
            script: Vec::new(),
            calls: Vec::new(),
        }
    }

    pub fn push(&mut self, result: TransportSendResult) {
        self.script.push(result);
    }

    pub fn calls(&self) -> &[TransportSendRequest] {
        &self.calls
    }
}

impl ChannelTransport for ScriptedTransport {
    fn idempotency_supported(&self) -> bool {
        self.idempotency_supported
    }

    fn send(&mut self, request: &TransportSendRequest) -> TransportSendResult {
        self.calls.push(request.clone());
        if self.script.is_empty() {
            return TransportSendResult::Timeout;
        }
        self.script.remove(0)
    }
}
