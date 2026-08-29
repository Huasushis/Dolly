//! Outbound effect ledger for `org.dolly.channel.send`.
//!
//! Delivery begins ONLY from a committed targeted Action whose arguments pass
//! the `channel-send` schema and whose result contract matches the frozen
//! semantic validator. The outbound ledger is keyed by `action_id`; a
//! terminal row is never re-dispatched, a confirmed replay returns the
//! existing result, and a timeout after bytes may have reached the transport
//! reconciles to `unknown`, never `failed`. Multi-part sends that are partly
//! confirmed become terminal `partial` and are reported through the common
//! error envelope as `CHANNEL_PARTIAL_DELIVERY` (`applied`), never collapsed
//! to success and never retried wholesale.

use dolly_canonical_json::{CanonicalJsonValue, canonicalize};
use dolly_schema::embedded_schema_catalog;
use serde_json::Value;

use crate::clock::Clock;
use crate::config::ChannelConfig;
use crate::error::{ChannelDeliveryOutcome, ChannelError, ChannelOutcome, codes};
use crate::ids;
use crate::ledger::{
    AttemptRecord, ChannelLedger, OutboundEntry, OutboundPiece, OutboundState, PieceOutcome,
};
use crate::rate_limit::OutboundAdmission;
use crate::result_validator::{
    RESULT_VALIDATOR_ID, RESULT_VALIDATOR_REVISION, SEND_RESULT_SCHEMA_TAG, validate_send_result,
    result_contract_matches,
};
use crate::transport::{ChannelTransport, TransportPiece, TransportPieceOutcome, TransportSendRequest, TransportSendResult};

/// The `$id` of the `channel-send` arguments schema.
pub const SEND_ARGUMENTS_SCHEMA_ID: &str =
    "https://dolly.example/spec/0.1/schemas/channel-send.schema.json";

/// One targeted `org.dolly.channel.send` action extracted from a committed
/// Block selected into this Module's Activation.
#[derive(Debug, Clone, PartialEq)]
pub struct SendAction {
    pub action_id: String,
    pub name: String,
    pub target_module_id: String,
    pub arguments: CanonicalJsonValue,
    pub result_validator_id: Option<String>,
    pub result_validator_revision: Option<i64>,
}

/// Extract the channel send action from a committed Block. The block must
/// carry an action named `org.dolly.channel.send` targeted at the configured
/// module; anything else is not an outbound Channel operation.
pub fn parse_send_action(block: &Value) -> Result<SendAction, ChannelError> {
    let rejected = |message: &str| {
        ChannelError::new(
            codes::MALFORMED_EVENT,
            false,
            ChannelOutcome::NotApplied,
            message,
        )
    };
    let obj = block
        .as_object()
        .ok_or_else(|| rejected("outbound block must be a JSON object"))?;
    let body = obj
        .get("body")
        .and_then(Value::as_object)
        .ok_or_else(|| rejected("outbound block missing body"))?;
    let actions = body
        .get("actions")
        .and_then(Value::as_array)
        .ok_or_else(|| rejected("outbound block body missing actions"))?;
    // A Block may carry only outbound actions targeted at this module; the
    // first matching action drives the send.
    for action in actions {
        let action_obj = action
            .as_object()
            .ok_or_else(|| rejected("action must be an object"))?;
        let name = action_obj
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| rejected("action missing name"))?;
        if name != crate::config::SEND_ACTION_NAME {
            return Err(ChannelError::new(
                codes::AUTHORIZATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                format!("action {name} is not owned by the channel, not a channel send"),
            ));
        }
        let action_id = action_obj
            .get("action_id")
            .and_then(Value::as_str)
            .ok_or_else(|| rejected("action missing action_id"))?;
        let target_module_id = action_obj
            .get("target")
            .and_then(|t| t.get("module_id"))
            .and_then(Value::as_str)
            .ok_or_else(|| rejected("action missing target module_id"))?;
        let arguments = serde_json::from_value::<CanonicalJsonValue>(
            action_obj
                .get("arguments")
                .cloned()
                .ok_or_else(|| rejected("action missing arguments"))?,
        )
        .map_err(|e| rejected(&format!("action arguments are not canonical JSON: {e}")))?;
        // Result contract from the frozen ActionContract binding.
        let binding = action_obj.get("contract_binding");
        let (result_validator_id, result_validator_revision) = binding
            .and_then(|b| b.get("action_contract"))
            .and_then(|c| c.get("result_schema"))
            .and_then(|s| s.get("semantic_validator"))
            .and_then(Value::as_object)
            .map(|v| {
                (
                    v.get("id").and_then(Value::as_str).map(|s| s.to_string()),
                    v.get("revision").and_then(Value::as_i64),
                )
            })
            .unwrap_or((None, None));
        return Ok(SendAction {
            action_id: action_id.to_string(),
            name: name.to_string(),
            target_module_id: target_module_id.to_string(),
            arguments,
            result_validator_id,
            result_validator_revision,
        });
    }
    Err(rejected("outbound block has no targeted channel send action"))
}

/// The outcome of one outbound send attempt.
#[derive(Debug, Clone, PartialEq)]
pub enum SendDispatchResult {
    /// A terminal outcome with its frozen `ActionResult` applied or not.
    Terminal {
        state: OutboundState,
        result: CanonicalJsonValue,
    },
    /// The transport response was lost; the row stays `dispatched` and MUST
    /// be reconciled before it may be treated as absent or failed.
    DispatchedPending,
    /// Rejected before any durable effect or transport call.
    Rejected(ChannelError),
}

/// One logged piece observation used to settle a pending dispatch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PieceObservation {
    pub ordinal: u32,
    pub outcome: PieceOutcome,
}

fn digest_of(value: &str) -> String {
    dolly_canonical_json::Sha256Digest::compute(value.as_bytes()).to_string()
}

/// Validate the arguments against the frozen `channel-send` schema.
fn validate_arguments(arguments: &CanonicalJsonValue) -> Result<(), ChannelError> {
    let catalog = embedded_schema_catalog().map_err(|e| {
        ChannelError::new(
            codes::INTERNAL,
            false,
            ChannelOutcome::NotApplied,
            format!("embedded schema catalog unavailable: {e}"),
        )
    })?;
    catalog
        .validate(SEND_ARGUMENTS_SCHEMA_ID, arguments, 32)
        .map_err(|errors| {
            ChannelError::new(
                codes::MALFORMED_EVENT,
                false,
                ChannelOutcome::NotApplied,
                format!("send arguments failed schema validation: {errors}"),
            )
        })
}

/// The validated parts of one authorized channel send: the account-owned
/// session and the v1 text pieces. Produced ONLY by [`authorize_send`] from a
/// committed targeted Action; no caller-shaped authority or payload reaches
/// this type.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AuthorizedSend {
    pub session_id: String,
    pub pieces: Vec<OutboundPiece>,
}

/// Shared authority verification for `org.dolly.channel.send`: owner name,
/// targeted module, frozen result contract, frozen arguments schema, an
/// account-owned session, and the v1 text-only pieces. Used by
/// [`dispatch_send`] and the committed targeted-Action verification boundary;
/// no durable effect and no transport call happens before this succeeds.
pub(crate) fn authorize_send(
    config: &ChannelConfig,
    ledger: &ChannelLedger,
    action: &SendAction,
) -> Result<AuthorizedSend, ChannelError> {
    // 1. Owner and target authority.
    if action.name != crate::config::SEND_ACTION_NAME {
        return Err(ChannelError::new(
            codes::AUTHORIZATION_FAILED,
            false,
            ChannelOutcome::NotApplied,
            format!("action {} is not a channel send", action.name),
        ));
    }
    if action.target_module_id != config.module_id {
        return Err(ChannelError::new(
            codes::AUTHORIZATION_FAILED,
            false,
            ChannelOutcome::NotApplied,
            format!(
                "action targets {} but this module is {}",
                action.target_module_id, config.module_id
            ),
        ));
    }
    if !result_contract_matches(action.result_validator_id.as_deref(), action.result_validator_revision)
    {
        return Err(ChannelError::new(
            codes::RESULT_CONTRACT_MISMATCH,
            false,
            ChannelOutcome::NotApplied,
            format!(
                "send result contract must bind {RESULT_VALIDATOR_ID} revision {RESULT_VALIDATOR_REVISION}"
            ),
        ));
    }
    if let Err(error) = validate_arguments(&action.arguments) {
        return Err(error);
    }

    // 2. Session authorization and text-only v1 parts.
    let arguments_obj = match &action.arguments {
        CanonicalJsonValue::Object(obj) => obj,
        _ => {
            return Err(ChannelError::new(
                codes::MALFORMED_EVENT,
                false,
                ChannelOutcome::NotApplied,
                "send arguments must be an object",
            ))
        }
    };
    let session_id = match arguments_obj.get("session_id") {
        Some(CanonicalJsonValue::String(session)) => session.clone(),
        _ => {
            return Err(ChannelError::new(
                codes::MALFORMED_EVENT,
                false,
                ChannelOutcome::NotApplied,
                "send arguments missing session_id",
            ))
        }
    };
    if !ledger.sessions.values().any(|s| *s == session_id) {
        return Err(ChannelError::new(
            codes::SESSION_MISSING,
            false,
            ChannelOutcome::NotApplied,
            format!("session {session_id} does not belong to this channel account"),
        ));
    }
    let parts = match arguments_obj.get("parts") {
        Some(CanonicalJsonValue::Array(items)) => items.clone(),
        _ => {
            return Err(ChannelError::new(
                codes::MALFORMED_EVENT,
                false,
                ChannelOutcome::NotApplied,
                "send arguments missing parts array",
            ))
        }
    };
    let mut pieces: Vec<OutboundPiece> = Vec::with_capacity(parts.len());
    for (ordinal, part) in parts.iter().enumerate() {
        let part_obj = match part {
            CanonicalJsonValue::Object(obj) => obj,
            _ => {
                return Err(ChannelError::new(
                    codes::MALFORMED_EVENT,
                    false,
                    ChannelOutcome::NotApplied,
                    "send part must be an object",
                ))
            }
        };
        let kind = match part_obj.get("kind") {
            Some(CanonicalJsonValue::String(kind)) => kind.as_str(),
            _ => "",
        };
        match kind {
            "text" => {
                let text = match part_obj.get("text") {
                    Some(CanonicalJsonValue::String(text)) => text.clone(),
                    _ => {
                        return Err(ChannelError::new(
                            codes::MALFORMED_EVENT,
                            false,
                            ChannelOutcome::NotApplied,
                            "text part missing text",
                        ))
                    }
                };
                if text.len() > config.max_text_bytes {
                    return Err(ChannelError::new(
                        codes::MALFORMED_EVENT,
                        false,
                        ChannelOutcome::NotApplied,
                        format!(
                            "text part {ordinal} exceeds configured maximum {} bytes",
                            config.max_text_bytes
                        ),
                    ));
                }
                pieces.push(OutboundPiece {
                    ordinal: ordinal as u32,
                    text,
                    transport_message_id: None,
                    outcome: None,
                });
            }
            "asset" => {
                // WP-013B seam: Asset parts are not deliverable in v1. They are
                // rejected with a distinct code before any transport call; text
                // parts alone remain supported.
                return Err(ChannelError::new(
                    codes::UNSUPPORTED_MODALITY,
                    false,
                    ChannelOutcome::NotApplied,
                    "asset parts require the WP-013B channel multimodal profile",
                ));
            }
            other => {
                return Err(ChannelError::new(
                    codes::MALFORMED_EVENT,
                    false,
                    ChannelOutcome::NotApplied,
                    format!("unsupported part kind {other}"),
                ));
            }
        }
    }
    if pieces.is_empty() {
        return Err(ChannelError::new(
            codes::MALFORMED_EVENT,
            false,
            ChannelOutcome::NotApplied,
            "send must contain at least one text part",
        ));
    }
    Ok(AuthorizedSend { session_id, pieces })
}

/// Dispatch one committed targeted channel send action.
///
/// Returns `Terminal` only when the ledger reached a closed outcome and the
/// frozen `ActionResult` is produced. `DispatchedPending` means the transport
/// response was lost and the durable outcome is unknown.
pub fn dispatch_send(
    config: &ChannelConfig,
    clock: &dyn Clock,
    ledger: &mut ChannelLedger,
    transport: &mut dyn ChannelTransport,
    admission: &mut OutboundAdmission,
    action: &SendAction,
) -> SendDispatchResult {
    // 1-2. Committed targeted-Action authority and text-only v1 pieces,
    // shared with the verification boundary. Nothing durable and no
    // transport call happens before this succeeds.
    let authorized = match authorize_send(config, ledger, action) {
        Ok(authorized) => authorized,
        Err(error) => return SendDispatchResult::Rejected(error),
    };
    let session_id = authorized.session_id;
    let pieces = authorized.pieces;

    // 3. Ledger idempotency: a terminal row is never re-dispatched.
    if let Some(existing) = ledger.outbound_entry(&action.action_id) {
        if existing.state.is_terminal() {
            if let Some(result_jcs) = &existing.result_jcs {
                if let Ok(value) = serde_json::from_str::<CanonicalJsonValue>(result_jcs) {
                    return SendDispatchResult::Terminal {
                        state: existing.state,
                        result: value,
                    };
                }
            }
            return SendDispatchResult::Rejected(ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::Unknown,
                "terminal outbound row has no frozen result",
            ));
        }
        // Crash state (prepared/dispatched): recovery below instead of a new
        // dispatch — a duplicate effect must never be created.
        return recover_pending_send(config, clock, ledger, &action.action_id);
    }

    // 4. Bounded admission.
    let pending_total = ledger
        .outbound
        .values()
        .filter(|e| !e.state.is_terminal())
        .count();
    let pending_per_session = ledger
        .outbound
        .values()
        .filter(|e| !e.state.is_terminal() && e.session_id == session_id)
        .count();
    if let Err(error) = admission.admit(
        clock,
        &config.outbound_limits,
        session_id.as_str(),
        pieces.len() as u64,
        pending_per_session,
        pending_total,
    ) {
        return SendDispatchResult::Rejected(error);
    }

    // 5. Persist `prepared` before any transport work.
    let now = clock.now().as_str().to_string();
    let idempotency_supported = transport.idempotency_supported();
    let entry = build_prepared_entry(
        config,
        clock,
        action,
        &session_id,
        pieces,
        idempotency_supported,
    );
    if ledger
        .insert_outbound(entry, config.ledger_bounds.outbound_max_entries)
        .is_err()
    {
        return SendDispatchResult::Rejected(ChannelError::new(
            codes::LEDGER_FULL,
            false,
            ChannelOutcome::NotApplied,
            "outbound ledger is at capacity",
        ));
    }

    // 6. Dispatch. When the transport has no idempotency key support the
    // `dispatched` marker MUST be durable before or atomically with send
    // initiation.
    transport_and_settle(config, ledger, transport, &action.action_id, &now, idempotency_supported)
}

/// Crate-internal: build the durable ledger `Prepared` entry for one
/// authorized send (mirrors the durable Prepared outbound record).
pub(crate) fn build_prepared_entry(
    config: &ChannelConfig,
    clock: &dyn Clock,
    action: &SendAction,
    session_id: &str,
    pieces: Vec<OutboundPiece>,
    idempotency_supported: bool,
) -> OutboundEntry {
    let now = clock.now().as_str().to_string();
    let idempotency_key = if idempotency_supported {
        Some(ids::outbound_idempotency_key(&action.action_id))
    } else {
        None
    };
    OutboundEntry {
        action_id: action.action_id.clone(),
        session_id: session_id.to_string(),
        config_revision: config.revision,
        state: OutboundState::Prepared,
        pieces,
        idempotency_supported,
        idempotency_key,
        attempts: vec![AttemptRecord {
            at: now.clone(),
            kind: "prepare".to_string(),
            detail_digest: digest_of(&config.revision.to_string()),
        }],
        dispatched_at: None,
        result_jcs: None,
    }
}

/// Crate-internal: drive one `Prepared` outbound row through the transport
/// and settle it. Shared by `dispatch_send` (fresh sends) and the
/// committed-Action consumer (re-admission of a Prepared send that never
/// reached dispatch). When the transport has no idempotency-key support the
/// caller MUST persist the durable `dispatched` marker before this call; the
/// in-memory marker is written here before send initiation.
pub(crate) fn transport_and_settle(
    config: &ChannelConfig,
    ledger: &mut ChannelLedger,
    transport: &mut dyn ChannelTransport,
    action_id: &str,
    now: &str,
    idempotency_supported: bool,
) -> SendDispatchResult {
    if !idempotency_supported {
        if let Some(existing) = ledger.outbound.get_mut(action_id) {
            existing.state = OutboundState::Dispatched;
            existing.dispatched_at = Some(now.to_string());
            existing.attempts.push(AttemptRecord {
                at: now.to_string(),
                kind: "dispatch".to_string(),
                detail_digest: digest_of("pre-dispatch"),
            });
        }
    }
    let request = TransportSendRequest {
        action_id: action_id.to_string(),
        idempotency_key: ledger
            .outbound_entry(action_id)
            .and_then(|e| e.idempotency_key.clone()),
        session_id: ledger
            .outbound_entry(action_id)
            .map(|e| e.session_id.clone())
            .unwrap_or_default(),
        pieces: ledger
            .outbound_entry(action_id)
            .map(|e| {
                e.pieces
                    .iter()
                    .map(|p| TransportPiece {
                        ordinal: p.ordinal,
                        text: p.text.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    };
    let result = transport.send(&request);
    if idempotency_supported {
        if let Some(existing) = ledger.outbound.get_mut(action_id) {
            existing.state = OutboundState::Dispatched;
            existing.dispatched_at = Some(now.to_string());
            existing.attempts.push(AttemptRecord {
                at: now.to_string(),
                kind: "dispatch".to_string(),
                detail_digest: digest_of("post-idempotent-send"),
            });
        }
    }
    apply_transport_observations(config, ledger, action_id, now, result)
}

/// Apply one transport call result to a ledger entry and produce the closed
/// outcome (or leave it pending when the response was lost).
fn apply_transport_observations(
    config: &ChannelConfig,
    ledger: &mut ChannelLedger,
    action_id: &str,
    now: &str,
    result: TransportSendResult,
) -> SendDispatchResult {
    let Some(entry) = ledger.outbound.get_mut(action_id) else {
        return SendDispatchResult::Rejected(ChannelError::new(
            codes::INTERNAL,
            false,
            ChannelOutcome::Unknown,
            "outbound row vanished during dispatch",
        ));
    };
    match result {
        TransportSendResult::AllConfirmed { message_ids } => {
            for piece in entry.pieces.iter_mut() {
                let id = message_ids
                    .get(piece.ordinal as usize)
                    .cloned()
                    .unwrap_or_else(|| format!("confirmed-{}", piece.ordinal));
                piece.transport_message_id = Some(id.clone());
                piece.outcome = Some(PieceOutcome::Confirmed {
                    transport_message_id: id,
                });
            }
        }
        TransportSendResult::PerPiece { pieces } => {
            for observation in pieces {
                let ordinal = match &observation {
                    TransportPieceOutcome::Confirmed { ordinal, .. }
                    | TransportPieceOutcome::Rejected { ordinal, .. }
                    | TransportPieceOutcome::Unknown { ordinal } => *ordinal,
                };
                if let Some(piece) = entry
                    .pieces
                    .iter_mut()
                    .find(|p| p.ordinal == ordinal)
                {
                    match observation {
                        TransportPieceOutcome::Confirmed { message_id, .. } => {
                            piece.transport_message_id = Some(message_id.clone());
                            piece.outcome = Some(PieceOutcome::Confirmed {
                                transport_message_id: message_id,
                            });
                        }
                        TransportPieceOutcome::Rejected { code, .. } => {
                            piece.outcome = Some(PieceOutcome::Rejected { code });
                        }
                        TransportPieceOutcome::Unknown { .. } => {
                            piece.outcome = Some(PieceOutcome::Unknown);
                        }
                    }
                }
            }
        }
        TransportSendResult::Timeout => {
            // Bytes may have reached the transport: every piece is unknown,
            // never failed.
            for piece in entry.pieces.iter_mut() {
                if piece.outcome.is_none() {
                    piece.outcome = Some(PieceOutcome::Unknown);
                }
            }
        }
        TransportSendResult::Rejected { code } => {
            for piece in entry.pieces.iter_mut() {
                if piece.outcome.is_none() {
                    piece.outcome = Some(PieceOutcome::Rejected {
                        code: code.clone(),
                    });
                }
            }
        }
    }
    settle_outbound_entry(config, ledger, action_id, now)
}

/// Reconcile a ledger entry from its recorded piece outcomes into a terminal
/// state and frozen `ActionResult`, or leave it pending (`dispatched`) when
/// the outcome is still unknown.
fn settle_outbound_entry(
    config: &ChannelConfig,
    ledger: &mut ChannelLedger,
    action_id: &str,
    now: &str,
) -> SendDispatchResult {
    let Some(entry) = ledger.outbound.get_mut(action_id) else {
        return SendDispatchResult::Rejected(ChannelError::new(
            codes::INTERNAL,
            false,
            ChannelOutcome::Unknown,
            "outbound row vanished during settle",
        ));
    };
    let mut confirmed = Vec::new();
    let mut failed = Vec::new();
    let mut unknown = Vec::new();
    for piece in &entry.pieces {
        match &piece.outcome {
            Some(PieceOutcome::Confirmed { .. }) => confirmed.push(piece.ordinal),
            Some(PieceOutcome::Rejected { .. }) => failed.push(piece.ordinal),
            Some(PieceOutcome::Unknown) | None => unknown.push(piece.ordinal),
        }
    }
    if confirmed.is_empty() && !unknown.is_empty() {
        // Unknown outcome: never failed, never re-dispatched. Must be
        // reconciled later or recovered by `recover_outbound`.
        entry.state = OutboundState::Dispatched;
        entry.attempts.push(AttemptRecord {
            at: now.to_string(),
            kind: "unknown-reconcile".to_string(),
            detail_digest: digest_of("pending"),
        });
        return SendDispatchResult::DispatchedPending;
    }

    let (state, result) = if failed.is_empty() && confirmed.len() == entry.pieces.len() {
        let messages: Vec<serde_json::Value> = entry
            .pieces
            .iter()
            .map(|p| {
                serde_json::json!({
                    "ordinal": p.ordinal,
                    "external_message_id": p.transport_message_id.clone().unwrap_or_default(),
                })
            })
            .collect();
        let send_result = serde_json::json!({
            "schema": SEND_RESULT_SCHEMA_TAG,
            "session_id": entry.session_id,
            "delivery_outcome": "sent",
            "messages": messages,
        });
        // The module guarantees its own output satisfies the bound semantic
        // validator; a violation here is an internal defect.
        let send_result: CanonicalJsonValue = match CanonicalJsonValue::try_from(send_result) {
            Ok(v) => v,
            Err(_) => {
                return SendDispatchResult::Rejected(ChannelError::new(
                    codes::INTERNAL,
                    false,
                    ChannelOutcome::Unknown,
                    "confirmed send result is not canonical",
                ))
            }
        };
        if let Err(message) = validate_send_result(&send_result) {
            return SendDispatchResult::Rejected(ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::Unknown,
                format!("confirmed send result failed its own validator: {message}"),
            ));
        }
        // A consumed outbound action produces a single ActionResult JSON Part:
        // the common `dolly.action-result/v1` envelope wrapping the send
        // result payload.
        let mut envelope = serde_json::Map::new();
        envelope.insert(
            "schema".into(),
            serde_json::Value::String("dolly.action-result/v1".into()),
        );
        envelope.insert("action_id".into(), serde_json::Value::String(action_id.into()));
        envelope.insert(
            "status".into(),
            serde_json::Value::String("succeeded".into()),
        );
        let send_result_json: serde_json::Value = serde_json::from_str(
            &dolly_canonical_json::canonicalize(&send_result)
                .map(|(b, _)| String::from_utf8(b.as_bytes().to_vec()).unwrap())
                .unwrap_or_default(),
        )
        .unwrap_or_default();
        envelope.insert("result".into(), send_result_json);
        envelope.insert("error".into(), serde_json::Value::Null);
        let canonical: CanonicalJsonValue = match CanonicalJsonValue::try_from(
            serde_json::Value::Object(envelope),
        ) {
            Ok(v) => v,
            Err(_) => {
                return SendDispatchResult::Rejected(ChannelError::new(
                    codes::INTERNAL,
                    false,
                    ChannelOutcome::Unknown,
                    "action result envelope is not canonical",
                ))
            }
        };
        (OutboundState::Confirmed, canonical)
    } else if !confirmed.is_empty() {
        // At least one piece confirmed and at least one failed or unknown.
        let mut details = serde_json::Map::new();
        details.insert(
            "delivery_outcome".into(),
            serde_json::Value::String("partial".into()),
        );
        details.insert(
            "confirmed_ordinals".into(),
            serde_json::Value::Array(confirmed.iter().map(|o| serde_json::json!(o)).collect()),
        );
        details.insert(
            "failed_ordinals".into(),
            serde_json::Value::Array(failed.iter().map(|o| serde_json::json!(o)).collect()),
        );
        details.insert(
            "unknown_ordinals".into(),
            serde_json::Value::Array(unknown.iter().map(|o| serde_json::json!(o)).collect()),
        );
        let error = ChannelError {
            code: codes::PARTIAL_DELIVERY.to_string(),
            retryable: false,
            outcome: ChannelOutcome::Applied,
            message: "some send pieces were delivered and others were not".to_string(),
            details: details
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        };
        (OutboundState::Partial, error_to_action_result(action_id, error))
    } else {
        // All pieces failed.
        let error = ChannelError::new(
            codes::TRANSPORT_REJECTED,
            false,
            ChannelOutcome::NotApplied,
            "transport rejected the send",
        )
        .with_delivery(ChannelDeliveryOutcome::NotSent);
        (OutboundState::Failed, error_to_action_result(action_id, error))
    };

    // Record echoed transports IDs so inbound echo suppression drops the
    // transport's own confirmation messages.
    let echoed: Vec<String> = entry
        .pieces
        .iter()
        .filter_map(|p| p.transport_message_id.clone())
        .collect();
    for id in echoed {
        ledger.record_echoed(&config.transport_account, &id);
    }

    let result_jcs = canonicalize(&result)
        .map(|(bytes, _)| String::from_utf8(bytes.as_bytes().to_vec()).expect("canonical UTF-8"))
        .unwrap_or_else(|_| "canonicalize-failed".to_string());
    if let Some(entry) = ledger.outbound.get_mut(action_id) {
        entry.state = state;
        entry.result_jcs = Some(result_jcs);
        entry.attempts.push(AttemptRecord {
            at: now.to_string(),
            kind: "settle".to_string(),
            detail_digest: digest_of(&entry.state.as_str().to_string()),
        });
    }
    SendDispatchResult::Terminal { state, result }
}

/// Build the common `ActionResult` JSON for a failed/unknown Channel send.
fn error_to_action_result(action_id: &str, error: ChannelError) -> CanonicalJsonValue {
    let mut map = serde_json::Map::new();
    map.insert(
        "schema".into(),
        serde_json::Value::String("dolly.action-result/v1".into()),
    );
    map.insert("action_id".into(), serde_json::Value::String(action_id.into()));
    let status = match error.outcome {
        ChannelOutcome::Unknown => "unknown",
        _ => "failed",
    };
    map.insert(
        "status".into(),
        serde_json::Value::String(status.into()),
    );
    map.insert("result".into(), serde_json::Value::Null);
    map.insert(
        "error".into(),
        serde_json::Value::Object(error.to_json_object()),
    );
    CanonicalJsonValue::try_from(serde_json::Value::Object(map))
        .expect("action result is canonical")
}

/// Recover crash-stale outbound rows: a `prepared`/`dispatched` row older
/// than the configured `unknown_after_seconds` is reconciled to `unknown`
/// (MUST NOT be failed or re-dispatched). Returns the reconciled action IDs.
/// A `Prepared` row that never recorded a dispatch attempt has never reached
/// the transport (the durable dispatched marker precedes send initiation);
/// it is left for the committed-Action consumer to dispatch and is NEVER
/// reconciled to `unknown`.
pub fn recover_outbound(
    config: &ChannelConfig,
    clock: &dyn Clock,
    ledger: &mut ChannelLedger,
) -> Vec<String> {
    let now_micros = crate::clock::timestamp_total_micros(clock.now().as_str());
    let stale_micros = config.outbound_limits.unknown_after_seconds as i64 * 1_000_000;
    let ids: Vec<String> = ledger
        .outbound
        .iter()
        .filter(|(_, e)| !e.state.is_terminal())
        .filter_map(|(id, e)| {
            if e.state == OutboundState::Prepared
                && !e.attempts.iter().any(|a| a.kind == "dispatch")
            {
                return None;
            }
            let at = e.dispatched_at.as_deref().or_else(|| {
                e.attempts
                    .first()
                    .map(|a| a.at.as_str())
            })?;
            let at_micros = crate::clock::timestamp_total_micros(at);
            (now_micros - at_micros >= stale_micros).then(|| id.clone())
        })
        .collect();
    for action_id in &ids {
        settle_recovered_unknown(config, ledger, action_id, clock.now().as_str());
    }
    ids
}

fn settle_recovered_unknown(
    _config: &ChannelConfig,
    ledger: &mut ChannelLedger,
    action_id: &str,
    now: &str,
) {
    if let Some(entry) = ledger.outbound.get_mut(action_id) {
        if entry.state.is_terminal() {
            return;
        }
        let outcome = if entry
            .pieces
            .iter()
            .any(|p| matches!(p.outcome, Some(PieceOutcome::Confirmed { .. })))
        {
            // Some pieces confirmed and others unknown: terminal partial per
            // the spec's partial rule (confirmed + unknown).
            let confirmed: Vec<u32> = entry
                .pieces
                .iter()
                .filter(|p| matches!(p.outcome, Some(PieceOutcome::Confirmed { .. })))
                .map(|p| p.ordinal)
                .collect();
            let failed: Vec<u32> = Vec::new();
            let unknown: Vec<u32> = entry
                .pieces
                .iter()
                .filter(|p| !matches!(p.outcome, Some(PieceOutcome::Confirmed { .. })))
                .map(|p| p.ordinal)
                .collect();
            let mut details = serde_json::Map::new();
            details.insert(
                "delivery_outcome".into(),
                serde_json::Value::String("partial".into()),
            );
            details.insert(
                "confirmed_ordinals".into(),
                serde_json::Value::Array(confirmed.iter().map(|o| serde_json::json!(o)).collect()),
            );
            details.insert(
                "failed_ordinals".into(),
                serde_json::Value::Array(failed.iter().map(|o| serde_json::json!(o)).collect()),
            );
            details.insert(
                "unknown_ordinals".into(),
                serde_json::Value::Array(unknown.iter().map(|o| serde_json::json!(o)).collect()),
            );
            let error = ChannelError {
                code: codes::PARTIAL_DELIVERY.to_string(),
                retryable: false,
                outcome: ChannelOutcome::Applied,
                message: "send timed out with some pieces confirmed".to_string(),
                details: details
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            };
            (OutboundState::Partial, error_to_action_result(action_id, error))
        } else {
            let error = ChannelError::new(
                codes::TRANSPORT_TIMEOUT,
                false,
                ChannelOutcome::Unknown,
                "send response lost; outcome is unknown, not failed",
            )
            .with_delivery(ChannelDeliveryOutcome::Unknown);
            (OutboundState::Unknown, error_to_action_result(action_id, error))
        };
        let result_jcs = canonicalize(&outcome.1)
            .map(|(bytes, _)| String::from_utf8(bytes.as_bytes().to_vec()).expect("canonical UTF-8"))
            .unwrap_or_else(|_| "canonicalize-failed".to_string());
        entry.state = outcome.0;
        entry.result_jcs = Some(result_jcs);
        entry.attempts.push(AttemptRecord {
            at: now.to_string(),
            kind: "recover".to_string(),
            detail_digest: digest_of(&outcome.0.as_str().to_string()),
        });
    }
}

/// Reconcile a pending (`prepared`/`dispatched`) row on a re-entry of the same
/// action (crash recovery). Never re-dispatches; the row is reconciled from
/// its recorded piece outcomes.
fn recover_pending_send(
    config: &ChannelConfig,
    clock: &dyn Clock,
    ledger: &mut ChannelLedger,
    action_id: &str,
) -> SendDispatchResult {
    let now = clock.now().as_str().to_string();
    let Some(entry) = ledger.outbound.get_mut(action_id) else {
        return SendDispatchResult::Rejected(ChannelError::new(
            codes::INTERNAL,
            false,
            ChannelOutcome::Unknown,
            "pending outbound row vanished",
        ));
    };
    let any_unknown = entry.pieces.iter().any(|p| {
        matches!(p.outcome, Some(PieceOutcome::Unknown) | None)
    });
    if any_unknown {
        // Still unresolved; may have reached the transport. Do not guess.
        return SendDispatchResult::DispatchedPending;
    }
    settle_outbound_entry(config, ledger, action_id, &now)
}

/// Apply late transport observations (webhook echoes, provider receipts) to a
/// pending row and seek a terminal reconciliation. Rows already terminal are
/// untouched so a confirmed result is never overwritten.
pub fn observe_outbound(
    config: &ChannelConfig,
    clock: &dyn Clock,
    ledger: &mut ChannelLedger,
    action_id: &str,
    observations: Vec<PieceObservation>,
) -> SendDispatchResult {
    let Some(entry) = ledger.outbound.get_mut(action_id) else {
        return SendDispatchResult::Rejected(ChannelError::new(
            codes::SESSION_MISSING,
            false,
            ChannelOutcome::NotApplied,
            "no outbound row for action_id",
        ));
    };
    if entry.state.is_terminal() {
        if let Some(result_jcs) = &entry.result_jcs {
            if let Ok(value) = serde_json::from_str::<CanonicalJsonValue>(result_jcs) {
                return SendDispatchResult::Terminal {
                    state: entry.state,
                    result: value,
                };
            }
        }
        return SendDispatchResult::Rejected(ChannelError::new(
            codes::INTERNAL,
            false,
            ChannelOutcome::Unknown,
            "terminal outbound row has no frozen result",
        ));
    }
    for observation in observations {
        if let Some(piece) = entry
            .pieces
            .iter_mut()
            .find(|p| p.ordinal == observation.ordinal)
        {
            match observation.outcome {
                PieceOutcome::Confirmed { transport_message_id } => {
                    piece.transport_message_id = Some(transport_message_id.clone());
                    piece.outcome = Some(PieceOutcome::Confirmed {
                        transport_message_id,
                    });
                }
                PieceOutcome::Rejected { code } => {
                    piece.outcome = Some(PieceOutcome::Rejected { code });
                }
                PieceOutcome::Unknown => {
                    piece.outcome = Some(PieceOutcome::Unknown);
                }
            }
        }
    }
    settle_outbound_entry(config, ledger, action_id, clock.now().as_str())
}

/// Whether `dispatch_send` returned a terminal result (used by tests).
pub fn is_terminal(result: &SendDispatchResult) -> bool {
    matches!(result, SendDispatchResult::Terminal { .. })
}
