//! Fail-closed injected transport seam for the Channel.
//!
//! The Channel never speaks to a real transport. Delivery goes through the
//! [`ChannelTransport`] seam, which is injected by the caller (a test double,
//! a recorded driver, or a production adapter). The seam communicates exactly
//! the outcome classes the specification requires: confirmed pieces with
//! transport message IDs, rejected pieces, and `Unknown` for timeouts or
//! losses after bytes may have reached the transport. The seam is also
//! **status-capable**: after a send whose response was lost (Dispatched), a
//! restart calls [`ChannelTransport::status`] with the idempotency key and
//! receives the exact transport-side outcome (confirmed/partial/unknown),
//! never a blind resend or an age-to-unknown guess.

/// One outbound piece handed to the transport: text, or a prepared asset
/// (frozen premise plus the opaque short-lease proof minted by the injected
/// Asset authority). The transport seam resolves asset bytes through that
/// proof; the Channel never reads asset bytes and never re-encodes parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportPiece {
    pub ordinal: u32,
    pub text: String,
    /// The prepared asset (asset pieces only). Absent for v1 text pieces.
    pub asset: Option<crate::asset::PreparedAsset>,
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

impl TransportPieceOutcome {
    pub fn ordinal(&self) -> u32 {
        match self {
            TransportPieceOutcome::Confirmed { ordinal, .. }
            | TransportPieceOutcome::Rejected { ordinal, .. }
            | TransportPieceOutcome::Unknown { ordinal } => *ordinal,
        }
    }
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

/// A status query for one previously-dispatched send whose response was lost.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportStatusRequest {
    /// The `action_id` of the original send.
    pub action_id: String,
    /// The idempotency key originally supplied (when supported).
    pub idempotency_key: Option<String>,
}

/// The exact transport-side status of one previously-dispatched send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportStatusResult {
    /// The send was confirmed; the transport IDs are known.
    Confirmed { message_ids: Vec<String> },
    /// The send was partially confirmed; per-piece outcomes are known.
    Partial { pieces: Vec<TransportPieceOutcome> },
    /// The send was rejected by the transport (nothing was delivered).
    Rejected { code: String },
    /// The transport does not know the outcome (response lost, timeout, or
    /// the send was never received). The Channel MUST NOT guess; this stays
    /// `Dispatched` and is retried status-first on the next reconcile.
    Unknown,
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
    /// Query the exact transport-side status of one previously-dispatched
    /// send whose response was lost. Used by status-first reconciliation on
    /// restart: the Channel calls this for every `Dispatched` row BEFORE any
    /// decision, never blind-resends, and never age-guesses to `unknown`.
    fn status(&mut self, request: &TransportStatusRequest) -> TransportStatusResult;
}

/// A deterministic scripted transport for tests and recorded drivers.
///
/// Scripts are consumed in order; a send past the end of the script fails
/// closed with `Timeout` (matching the specification's bias toward `unknown`
/// over a fabricated failure). Status scripts are consumed in order per
/// `action_id`; a status query past the end returns `Unknown`.
#[derive(Debug, Clone, Default)]
pub struct ScriptedTransport {
    idempotency_supported: bool,
    script: Vec<TransportSendResult>,
    calls: Vec<TransportSendRequest>,
    status_script: Vec<(String, TransportStatusResult)>,
    status_calls: Vec<TransportStatusRequest>,
}

impl ScriptedTransport {
    pub fn new(idempotency_supported: bool) -> Self {
        Self {
            idempotency_supported,
            script: Vec::new(),
            calls: Vec::new(),
            status_script: Vec::new(),
            status_calls: Vec::new(),
        }
    }

    pub fn push(&mut self, result: TransportSendResult) {
        self.script.push(result);
    }

    pub fn push_status(&mut self, action_id: &str, result: TransportStatusResult) {
        self.status_script.push((action_id.to_string(), result));
    }

    pub fn calls(&self) -> &[TransportSendRequest] {
        &self.calls
    }

    pub fn status_calls(&self) -> &[TransportStatusRequest] {
        &self.status_calls
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

    fn status(&mut self, request: &TransportStatusRequest) -> TransportStatusResult {
        self.status_calls.push(request.clone());
        // Find the first matching scripted status for this action_id.
        let pos = self
            .status_script
            .iter()
            .position(|(id, _)| id == &request.action_id);
        match pos {
            Some(idx) => self.status_script.remove(idx).1,
            None => TransportStatusResult::Unknown,
        }
    }
}
