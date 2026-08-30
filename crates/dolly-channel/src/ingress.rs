//! Inbound text ingress pipeline for `org.dolly.channel`.
//!
//! One authenticated external transport event becomes a `dolly.block-draft/v1`
//! document submitted to Core only through the [`CoreIngress`] seam
//! (`host.ingress.submit` / `host.ingress.status`). Every authorization,
//! malformed-input, deduplication, and staleness check runs BEFORE any durable
//! mutation, and the ingress key is account-scoped so reusing an external ID
//! in another account can never collide.
//!
//! The ledger-to-Core contract mirrors the reducer's `Ingress` command:
//! re-submitting under the same account-scoped key replays the prior mapping,
//! and a different operation digest under the same key is an idempotency
//! conflict. A lost submit response is reconciled through `status` first; only
//! an authoritative `absent` permits replay of the byte-identical request.

use dolly_canonical_json::{CanonicalJsonValue, canonicalize};
use dolly_core_domain::Timestamp;
use serde_json::Value;

use crate::attachment::{AttachmentRecord, AttachmentState, InboundAttachment};
use crate::clock::{Clock, timestamp_plus_seconds};
use crate::config::ChannelConfig;
use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::ids;
use crate::ledger::{AttemptRecord, ChannelLedger, EventKind, InboundEntry, InboundState};

/// The metadata namespace every Channel draft carries.
pub const CHANNEL_METADATA_NAMESPACE: &str = "org.dolly.channel";
/// The block-draft schema tag.
pub const BLOCK_DRAFT_SCHEMA_TAG: &str = "dolly.block-draft/v1";
/// Bound mirroring external ID limits.
pub const MAX_EXTERNAL_ID_BYTES: usize = 512;

// ---------------------------------------------------------------------------
// Authenticated external event
// ---------------------------------------------------------------------------

/// One authenticated external transport event. The transport layer has already
/// proven the connection; the module authorizes the payload sender,
/// conversation, session, and account before any mutation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundEvent {
    pub channel_id: String,
    /// Transport kind (`web`, `cli`, `test-harness`, ...).
    pub transport: String,
    /// The authenticated transport account. MUST equal the configured account
    /// or the event is rejected as cross-owner.
    pub account: String,
    pub external_conversation_id: String,
    pub external_message_id: String,
    pub sender_class: String,
    pub sender_id: String,
    pub text: String,
    pub received_at: Timestamp,
    pub event_kind: EventKind,
    /// For edit/delete events: the referenced original external message ID.
    pub references_external_message_id: Option<String>,
    /// Ordered typed provider attachments (empty for v1 text events).
    pub attachments: Vec<InboundAttachment>,
}

/// Parse and strictly validate one raw transport event. Malformed events fail
/// here with `CHANNEL_MALFORMED_EVENT` and no durable mutation.
pub fn parse_event(raw: &Value) -> Result<InboundEvent, ChannelError> {
    let malformed = |message: &str| {
        ChannelError::new(
            codes::MALFORMED_EVENT,
            false,
            ChannelOutcome::NotApplied,
            message,
        )
    };
    let obj = raw
        .as_object()
        .ok_or_else(|| malformed("inbound event must be a JSON object"))?;
    let get = |key: &str| -> Result<&str, ChannelError> {
        obj.get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| malformed(&format!("inbound event missing string field {key}")))
    };
    let check_id = |value: &str, field: &str| -> Result<(), ChannelError> {
        if value.is_empty() || value.len() > MAX_EXTERNAL_ID_BYTES {
            return Err(malformed(&format!(
                "inbound event {field} must be 1..={MAX_EXTERNAL_ID_BYTES} bytes"
            )));
        }
        if value.chars().any(|c| c.is_control()) {
            return Err(malformed(&format!(
                "inbound event {field} must not contain control characters"
            )));
        }
        Ok(())
    };
    let channel_id = get("channel_id")?;
    let transport = get("transport")?;
    let account = get("account")?;
    let conversation = get("external_conversation_id")?;
    let message_id = get("external_message_id")?;
    let sender_class = get("sender_class")?;
    let sender_id = get("sender_id")?;
    let text = get("text")?;
    let received_at = get("received_at")?;
    for (v, f) in [
        (channel_id, "channel_id"),
        (account, "account"),
        (conversation, "external_conversation_id"),
        (message_id, "external_message_id"),
        (sender_class, "sender_class"),
        (sender_id, "sender_id"),
    ] {
        check_id(v, f)?;
    }
    let received_at = received_at
        .parse::<Timestamp>()
        .map_err(|_| malformed("inbound event received_at must be a Core timestamp"))?;
    let event_kind = match obj.get("event_kind").and_then(Value::as_str) {
        Some("message") => EventKind::Message,
        Some("edit") => EventKind::Edit,
        Some("delete") => EventKind::Delete,
        _ => {
            return Err(malformed(
                "inbound event event_kind must be message|edit|delete",
            ));
        }
    };
    let references_external_message_id = match obj.get("references_external_message_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            check_id(s, "references_external_message_id")?;
            Some(s.clone())
        }
        Some(_) => {
            return Err(malformed(
                "inbound event references_external_message_id must be a string or null",
            ));
        }
    };
    if matches!(event_kind, EventKind::Edit | EventKind::Delete)
        && references_external_message_id.is_none()
    {
        return Err(malformed(
            "edit/delete events must reference the original external message",
        ));
    }
    Ok(InboundEvent {
        channel_id: channel_id.to_string(),
        transport: transport.to_string(),
        account: account.to_string(),
        external_conversation_id: conversation.to_string(),
        external_message_id: message_id.to_string(),
        sender_class: sender_class.to_string(),
        sender_id: sender_id.to_string(),
        text: text.to_string(),
        received_at,
        event_kind,
        references_external_message_id,
        attachments: parse_attachments(obj, &malformed)?,
    })
}

/// Parse the ordered typed provider attachments of one raw transport event.
/// The array is optional (v1 text events carry none); every attachment is
/// strictly validated for identity and bound limits, and ordinals must be
/// contiguous from zero (attachment order is part of the draft).
fn parse_attachments(
    obj: &serde_json::Map<String, Value>,
    malformed: &dyn Fn(&str) -> ChannelError,
) -> Result<Vec<InboundAttachment>, ChannelError> {
    let items = match obj.get("attachments") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => {
            return Err(malformed(
                "inbound event attachments must be an array or absent",
            ));
        }
    };
    let mut attachments = Vec::with_capacity(items.len());
    for (expected, item) in items.iter().enumerate() {
        let obj = item
            .as_object()
            .ok_or_else(|| malformed("attachment must be an object"))?;
        let ordinal = obj
            .get("ordinal")
            .and_then(Value::as_u64)
            .map(|value| value as u32)
            .ok_or_else(|| malformed("attachment missing ordinal"))?;
        if ordinal as usize != expected {
            return Err(malformed(
                "attachment ordinals must be contiguous from zero (order is part of the draft)",
            ));
        }
        let provider_key = obj
            .get("provider_key")
            .and_then(Value::as_str)
            .ok_or_else(|| malformed("attachment missing provider_key"))?
            .to_string();
        if provider_key.is_empty() || provider_key.len() > MAX_EXTERNAL_ID_BYTES {
            return Err(malformed(&format!(
                "attachment provider_key must be 1..={MAX_EXTERNAL_ID_BYTES} bytes"
            )));
        }
        let declared_media_type = obj
            .get("declared_media_type")
            .and_then(Value::as_str)
            .ok_or_else(|| malformed("attachment missing declared_media_type"))
            .and_then(|value| {
                crate::asset::MediaType::parse(value)
                    .map_err(|_| malformed("attachment declared_media_type is not canonical"))
            })?;
        let media_kind = match obj.get("media_kind").and_then(Value::as_str) {
            Some("image") => crate::asset::MediaKind::Image,
            Some("audio") => crate::asset::MediaKind::Audio,
            Some("video") => crate::asset::MediaKind::Video,
            Some("file") => crate::asset::MediaKind::File,
            _ => return Err(malformed("attachment media_kind is not closed")),
        };
        let byte_length_hint = obj
            .get("byte_length_hint")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .ok_or_else(|| malformed("attachment byte_length_hint must be positive"))?;
        attachments.push(InboundAttachment {
            ordinal,
            provider_key,
            media_kind,
            declared_media_type,
            byte_length_hint,
        });
    }
    crate::attachment::validate_attachment_sequence(
        &attachments,
        usize::MAX,
        crate::asset::AssetRef::MAX_WIRE_SAFE_INTEGER,
    )?;
    Ok(attachments)
}

/// Normalize external text without changing its semantic characters: line
/// endings are canonicalized (CRLF/CR -> LF) and unsafe characters (C0
/// controls other than `\t`/`\n`, and Unicode noncharacters) are rejected.
pub fn normalize_text(text: &str) -> Result<String, ChannelError> {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    let _ = chars.next();
                }
                out.push('\n');
            }
            '\t' | '\n' => out.push(c),
            c if (c as u32) < 0x20 => {
                return Err(ChannelError::new(
                    codes::MALFORMED_EVENT,
                    false,
                    ChannelOutcome::NotApplied,
                    "inbound text contains a control character",
                ));
            }
            c if is_noncharacter(c) => {
                return Err(ChannelError::new(
                    codes::MALFORMED_EVENT,
                    false,
                    ChannelOutcome::NotApplied,
                    "inbound text contains a Unicode noncharacter",
                ));
            }
            c => out.push(c),
        }
    }
    Ok(out)
}

fn is_noncharacter(c: char) -> bool {
    let u = c as u32;
    (0xFDD0..=0xFDEF).contains(&u) || (u & 0xFFFE) == 0xFFFE || (u & 0xFFFF) == 0xFFFF
}

// ---------------------------------------------------------------------------
// Core ingress seam (host.ingress.submit / host.ingress.status)
// ---------------------------------------------------------------------------

/// The params of one `host.ingress.submit` call.
#[derive(Debug, Clone, PartialEq)]
pub struct IngressSubmitRequest {
    pub operation_id: String,
    pub module_id: String,
    /// Account-scoped stable idempotency key.
    pub idempotency_key: String,
    /// The `dolly.block-draft/v1` document.
    pub draft: CanonicalJsonValue,
    /// Only the configured target Pages.
    pub target_page_ids: Vec<String>,
    pub deadline: String,
}

impl IngressSubmitRequest {
    /// Canonical bytes of the draft, the byte-identical replay unit.
    pub fn draft_canonical_bytes(&self) -> Result<Vec<u8>, ChannelError> {
        let (bytes, _) = canonicalize(&self.draft).map_err(|e| {
            ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::NotApplied,
                format!("draft failed canonicalization: {e}"),
            )
        })?;
        Ok(bytes.as_bytes().to_vec())
    }

    /// The operation digest: SHA-256 over the canonical draft bytes. Core
    /// replays idempotently exactly when this digest matches the stored one.
    pub fn operation_digest(&self) -> Result<String, ChannelError> {
        Ok(ids::operation_digest(&self.draft_canonical_bytes()?))
    }
}

/// A committed ingress mapping returned by Core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngressCommit {
    pub ingress_id: String,
    pub block_id: String,
    pub graph_revision: i64,
    /// `(page_id, page_seq, commit_seq)` deliveries.
    pub deliveries: Vec<(String, i64, i64)>,
}

/// The receipt of one `host.ingress.submit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngressSubmitReceipt {
    /// Fresh or idempotent commit; `idempotent` distinguishes a replay of a
    /// prior mapping from a first commit.
    Committed {
        idempotent: bool,
        commit: IngressCommit,
    },
}

/// The result of one `host.ingress.status`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngressStatusResult {
    /// Authoritative absent: only this permits replay of a byte-identical
    /// request.
    Absent,
    Committed {
        commit: IngressCommit,
    },
}

/// A failure from the Core ingress seam.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreIngressError {
    /// The response was lost: the durable outcome is unknown.
    UnknownOutcome,
    /// The Core/Host is unavailable; the submission was not acknowledged.
    Unavailable,
    /// Core rejected the request with a code (for example an idempotency
    /// conflict for a different digest under the same key).
    Rejected { code: String },
}

/// The `host.ingress.*` seam. The module only ever talks through this
/// boundary and never touches Pages or cursors directly.
pub trait CoreIngress {
    fn submit(
        &mut self,
        request: &IngressSubmitRequest,
    ) -> Result<IngressSubmitReceipt, CoreIngressError>;
    fn status(
        &mut self,
        operation_id: &str,
        module_id: &str,
        idempotency_key: &str,
        deadline: &str,
    ) -> Result<IngressStatusResult, CoreIngressError>;
}

// ---------------------------------------------------------------------------
// Ingress outcomes
// ---------------------------------------------------------------------------

/// The outcome of processing one inbound event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngressOutcome {
    /// The event was an inbound echo of a previously confirmed outbound send;
    /// nothing was mutated and nothing was submitted.
    EchoIgnored,
    /// The exact same event was already accepted; the prior Core-minted Block
    /// mapping is replayed with no new Core call.
    IdempotentReplay { block_id: String },
    /// A fresh (or crash-recovered) commit reached Core.
    Committed {
        block_id: String,
        idempotent: bool,
        ingress_id: String,
    },
    /// The submit response was lost; the durable Core outcome is unknown. The
    /// caller MUST reconcile through [`reconcile_inbound`].
    SubmissionPending,
    /// Rejected before any durable mutation.
    RejectedBeforeMutation { error: ChannelError },
    /// Core durably rejected the submission.
    CoreRejected { error: ChannelError },
}

impl IngressOutcome {
    pub fn committed_block_id(&self) -> Option<&str> {
        match self {
            IngressOutcome::IdempotentReplay { block_id }
            | IngressOutcome::Committed { block_id, .. } => Some(block_id),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

pub(crate) fn digest_of(value: &str) -> String {
    dolly_canonical_json::Sha256Digest::compute(value.as_bytes()).to_string()
}

pub(crate) fn build_draft(
    event: &InboundEvent,
    session_id: &str,
    normalized_text: &str,
) -> Result<CanonicalJsonValue, ChannelError> {
    let mut record = serde_json::Map::new();
    record.insert(
        "channel_id".into(),
        serde_json::Value::String(event.channel_id.clone()),
    );
    record.insert(
        "transport".into(),
        serde_json::Value::String(event.transport.clone()),
    );
    record.insert(
        "session_id".into(),
        serde_json::Value::String(session_id.to_string()),
    );
    record.insert(
        "external_conversation_id".into(),
        serde_json::Value::String(event.external_conversation_id.clone()),
    );
    record.insert(
        "external_message_id".into(),
        serde_json::Value::String(event.external_message_id.clone()),
    );
    record.insert(
        "sender_class".into(),
        serde_json::Value::String(event.sender_class.clone()),
    );
    record.insert(
        "received_at".into(),
        serde_json::Value::String(event.received_at.as_str().to_string()),
    );
    record.insert(
        "event_kind".into(),
        serde_json::Value::String(event.event_kind.as_str().to_string()),
    );
    if let Some(references) = &event.references_external_message_id {
        record.insert(
            "references_external_message_id".into(),
            serde_json::Value::String(references.clone()),
        );
    }

    let parts = match event.event_kind {
        EventKind::Delete => Vec::new(),
        EventKind::Message | EventKind::Edit => vec![serde_json::json!({
            "kind": "text",
            "text": normalized_text,
            "format": "plain"
        })],
    };
    let draft = serde_json::json!({
        "schema": BLOCK_DRAFT_SCHEMA_TAG,
        "parts": parts,
        "actions": [],
        "metadata": {
            CHANNEL_METADATA_NAMESPACE: serde_json::Value::Object(record)
        }
    });
    CanonicalJsonValue::try_from(draft).map_err(|e| {
        ChannelError::new(
            codes::INTERNAL,
            false,
            ChannelOutcome::NotApplied,
            format!("draft is not canonical JSON: {e}"),
        )
    })
}

/// Build the canonical Block draft for one inbound event whose attachments
/// are ALL AVAILABLE: the ordered Core `Part` text + asset parts (attachment
/// order is preserved exactly) and the unchanged metadata record. Only
/// AVAILABLE attachment results may become draft references; anything else
/// must be represented explicitly and never as a fabricated reference.
pub(crate) fn build_draft_with_attachments(
    event: &InboundEvent,
    session_id: &str,
    normalized_text: &str,
    available: &[crate::attachment::AvailableAttachment],
) -> Result<CanonicalJsonValue, ChannelError> {
    let mut parts = match event.event_kind {
        EventKind::Delete => Vec::new(),
        EventKind::Message | EventKind::Edit => vec![serde_json::json!({
            "kind": "text",
            "text": normalized_text,
            "format": "plain"
        })],
    };
    for attachment in available {
        let mut part = serde_json::json!({
            "kind": "asset",
            "asset_id": attachment.asset_ref.asset_id,
            "media_type": attachment.asset_ref.media_type,
        });
        if let Some(view) = &attachment.view {
            part["view"] = serde_json::to_value(view).expect("canonical crop serializes");
        }
        parts.push(part);
    }
    let mut record = serde_json::Map::new();
    record.insert(
        "channel_id".into(),
        serde_json::Value::String(event.channel_id.clone()),
    );
    record.insert(
        "transport".into(),
        serde_json::Value::String(event.transport.clone()),
    );
    record.insert(
        "session_id".into(),
        serde_json::Value::String(session_id.to_string()),
    );
    record.insert(
        "external_conversation_id".into(),
        serde_json::Value::String(event.external_conversation_id.clone()),
    );
    record.insert(
        "external_message_id".into(),
        serde_json::Value::String(event.external_message_id.clone()),
    );
    record.insert(
        "sender_class".into(),
        serde_json::Value::String(event.sender_class.clone()),
    );
    record.insert(
        "received_at".into(),
        serde_json::Value::String(event.received_at.as_str().to_string()),
    );
    record.insert(
        "event_kind".into(),
        serde_json::Value::String(event.event_kind.as_str().to_string()),
    );
    if let Some(references) = &event.references_external_message_id {
        record.insert(
            "references_external_message_id".into(),
            serde_json::Value::String(references.clone()),
        );
    }
    let draft = serde_json::json!({
        "schema": BLOCK_DRAFT_SCHEMA_TAG,
        "parts": parts,
        "actions": [],
        "metadata": {
            CHANNEL_METADATA_NAMESPACE: serde_json::Value::Object(record)
        }
    });
    CanonicalJsonValue::try_from(draft).map_err(|e| {
        ChannelError::new(
            codes::INTERNAL,
            false,
            ChannelOutcome::NotApplied,
            format!("draft is not canonical JSON: {e}"),
        )
    })
}

pub(crate) fn draft_canonical_string(draft: &CanonicalJsonValue) -> Result<String, ChannelError> {
    canonicalize(draft)
        .map(|(bytes, _)| String::from_utf8(bytes.as_bytes().to_vec()).expect("canonical UTF-8"))
        .map_err(|_| {
            ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::NotApplied,
                "draft failed canonicalization",
            )
        })
}

/// Process one authenticated external event end to end. The accepted
/// text-only default refuses attachment events before mutation.
pub fn process_event<E: CoreIngress>(
    config: &ChannelConfig,
    clock: &dyn Clock,
    ledger: &mut ChannelLedger,
    core: &mut E,
    event: &InboundEvent,
) -> IngressOutcome {
    process_event_inner(config, clock, ledger, core, false, event)
}

/// Build and retain a complete ordered `assets_pending` intent without
/// calling Asset. [`crate::receiver::InboundReceiver`] persists that intent
/// and then uses its sole attachment state machine for initial import and
/// recovery.
pub(crate) fn process_event_with_pending_attachments<E: CoreIngress>(
    config: &ChannelConfig,
    clock: &dyn Clock,
    ledger: &mut ChannelLedger,
    core: &mut E,
    event: &InboundEvent,
) -> IngressOutcome {
    process_event_inner(config, clock, ledger, core, true, event)
}

fn process_event_inner<E: CoreIngress>(
    config: &ChannelConfig,
    clock: &dyn Clock,
    ledger: &mut ChannelLedger,
    core: &mut E,
    allow_pending_attachments: bool,
    event: &InboundEvent,
) -> IngressOutcome {
    let reject_before_mutation =
        |error: ChannelError| IngressOutcome::RejectedBeforeMutation { error };

    if !config.ingress_enabled {
        return reject_before_mutation(ChannelError::new(
            codes::INGRESS_DISABLED,
            false,
            ChannelOutcome::NotApplied,
            "channel ingress is disabled by configuration",
        ));
    }
    if event.account != config.transport_account {
        return reject_before_mutation(ChannelError::new(
            codes::AUTHENTICATION_FAILED,
            false,
            ChannelOutcome::NotApplied,
            format!(
                "event account {} does not match configured account {}",
                event.account, config.transport_account
            ),
        ));
    }
    if matches!(event.event_kind, EventKind::Edit | EventKind::Delete)
        && !config.edit_delete.enabled
    {
        return reject_before_mutation(ChannelError::new(
            codes::STALE_EVENT,
            false,
            ChannelOutcome::NotApplied,
            "external edit/delete handling is disabled by configuration",
        ));
    }
    // Echoed outbound suppression: a transport echo of a confirmed outbound
    // piece must never re-enter Dolly as a user message.
    if ledger.is_echo(&event.account, &event.external_message_id) {
        return IngressOutcome::EchoIgnored;
    }
    // Sender/conversation/class authorization.
    if !config.allowed_sender_classes.contains(&event.sender_class) {
        return reject_before_mutation(ChannelError::new(
            codes::AUTHORIZATION_FAILED,
            false,
            ChannelOutcome::NotApplied,
            format!("sender class {} is not authorized", event.sender_class),
        ));
    }
    if let Some(allowed) = &config.allowed_senders {
        if !allowed.contains(&event.sender_id) {
            return reject_before_mutation(ChannelError::new(
                codes::AUTHORIZATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                format!("sender {} is not authorized", event.sender_id),
            ));
        }
    }
    if let Some(allowed) = &config.allowed_conversations {
        if !allowed.contains(&event.external_conversation_id) {
            return reject_before_mutation(ChannelError::new(
                codes::AUTHORIZATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                format!(
                    "conversation {} is not authorized",
                    event.external_conversation_id
                ),
            ));
        }
    }

    // Session resolution.
    let session_id = match ledger.session(&event.account, &event.external_conversation_id) {
        Some(session) => session.clone(),
        None => match config.session_mapping_policy {
            crate::config::SessionMappingPolicy::RequireKnown => {
                return reject_before_mutation(ChannelError::new(
                    codes::SESSION_MISSING,
                    false,
                    ChannelOutcome::NotApplied,
                    format!(
                        "no session mapped for conversation {} under require_known",
                        event.external_conversation_id
                    ),
                ));
            }
            crate::config::SessionMappingPolicy::CreateOnFirstMessage => {
                let session =
                    ids::dolly_session_id(&event.account, &event.external_conversation_id);
                ledger.insert_session(&event.account, &event.external_conversation_id, &session);
                session
            }
        },
    };

    // Normalization and size limits (malformed events fail before mutation).
    let normalized = match normalize_text(&event.text) {
        Ok(text) => text,
        Err(error) => return reject_before_mutation(error),
    };
    if normalized.len() > config.max_text_bytes {
        return reject_before_mutation(ChannelError::new(
            codes::MALFORMED_EVENT,
            false,
            ChannelOutcome::NotApplied,
            format!(
                "normalized text is {} bytes, exceeding configured maximum {}",
                normalized.len(),
                config.max_text_bytes
            ),
        ));
    }

    // Edit/delete must reference a known inbound message (stale rejection).
    if let Some(references) = &event.references_external_message_id {
        if ledger.inbound_entry(&event.account, references).is_none() {
            return reject_before_mutation(ChannelError::new(
                codes::STALE_EVENT,
                false,
                ChannelOutcome::NotApplied,
                format!("edit/delete references unknown external message {references}"),
            ));
        }
    }

    // Attachment intents are closed-validated and represented in full as
    // Pending before any real Asset import. The durable receiver persists
    // this complete ordered state, then starts imports through its one
    // start/recovery state machine.
    let mut attachment_records: Vec<AttachmentRecord> = Vec::new();
    if !event.attachments.is_empty() {
        if !allow_pending_attachments || !config.accepted_modalities.contains("asset") {
            return reject_before_mutation(ChannelError::new(
                codes::UNSUPPORTED_MODALITY,
                false,
                ChannelOutcome::NotApplied,
                "attachment events require the accepted Channel asset modality",
            ));
        }
        if let Err(error) = crate::attachment::validate_attachment_sequence(
            &event.attachments,
            config.max_parts.saturating_sub(1),
            config.max_asset_bytes as u64,
        ) {
            return reject_before_mutation(error);
        }
        attachment_records.extend(event.attachments.iter().cloned().map(|attachment| {
            AttachmentRecord {
                attachment,
                state: AttachmentState::Pending,
                available: None,
                refused_code: None,
            }
        }));
        let now = clock.now().as_str().to_string();
        let ingress_key = ids::inbound_ingress_key(&event.account, &event.external_message_id);
        let placeholder = match build_draft_with_attachments(event, &session_id, &normalized, &[]) {
            Ok(draft) => draft,
            Err(error) => return reject_before_mutation(error),
        };
        let request_jcs = match draft_canonical_string(&placeholder) {
            Ok(bytes) => bytes,
            Err(error) => return reject_before_mutation(error),
        };
        let operation_digest = ids::operation_digest(request_jcs.as_bytes());
        let entry = InboundEntry {
            transport_account: event.account.clone(),
            external_message_id: event.external_message_id.clone(),
            references_external_message_id: event.references_external_message_id.clone(),
            state: InboundState::AssetsPending,
            event_kind: event.event_kind,
            session_id: session_id.clone(),
            external_conversation_id: event.external_conversation_id.clone(),
            channel_id: event.channel_id.clone(),
            sender_class: event.sender_class.clone(),
            received_at: now.clone(),
            ingress_key: ingress_key.clone(),
            operation_digest,
            block_id: None,
            attachments: attachment_records,
            pages: config.target_page_ids.clone(),
            config_revision: config.revision,
            attempts: vec![AttemptRecord {
                at: now,
                kind: "assets-pending".to_string(),
                detail_digest: crate::ingress::digest_of(&ingress_key),
            }],
            request_jcs,
            rejected_code: None,
        };
        if ledger
            .insert_inbound(entry, config.ledger_bounds.inbound_max_entries)
            .is_err()
        {
            return reject_before_mutation(ChannelError::new(
                codes::LEDGER_FULL,
                false,
                ChannelOutcome::NotApplied,
                "inbound ledger is at capacity",
            ));
        }
        return IngressOutcome::SubmissionPending;
    }

    // Build the draft and the account-scoped idempotency identity.
    let draft = match build_draft_with_attachments(event, &session_id, &normalized, &[]) {
        Ok(draft) => draft,
        Err(error) => return reject_before_mutation(error),
    };
    let request_jcs = match draft_canonical_string(&draft) {
        Ok(bytes) => bytes,
        Err(error) => return reject_before_mutation(error),
    };
    let ingress_key = ids::inbound_ingress_key(&event.account, &event.external_message_id);
    let operation_digest = ids::operation_digest(request_jcs.as_bytes());
    let deadline = timestamp_plus_seconds(
        clock.now().as_str(),
        config.operation_deadline_seconds as i64,
    );
    let request = IngressSubmitRequest {
        operation_id: ids::operation_id(&event.account, &event.external_message_id, 1),
        module_id: config.module_id.clone(),
        idempotency_key: ingress_key.clone(),
        draft: draft.clone(),
        target_page_ids: config.target_page_ids.clone(),
        deadline: deadline.clone(),
    };

    let now = clock.now().as_str().to_string();

    // Deduplication lookup.
    if let Some(existing) = ledger.inbound_entry(&event.account, &event.external_message_id) {
        match existing.state {
            InboundState::Accepted => {
                if existing.request_jcs == request_jcs {
                    let block_id = existing
                        .block_id
                        .clone()
                        .expect("accepted entry always has a block id");
                    return IngressOutcome::IdempotentReplay { block_id };
                }
                return reject_before_mutation(ChannelError::new(
                    codes::OPERATION_CONFLICT,
                    false,
                    ChannelOutcome::NotApplied,
                    "external message ID was already accepted with different content",
                ));
            }
            InboundState::Rejected => {
                let code = existing
                    .rejected_code
                    .clone()
                    .unwrap_or_else(|| codes::INTERNAL.to_string());
                return reject_before_mutation(ChannelError::new(
                    code,
                    false,
                    ChannelOutcome::NotApplied,
                    "external message ID was already rejected",
                ));
            }
            InboundState::Received | InboundState::Submitted | InboundState::AssetsPending => {
                // Crash recovery: proceed to Core below (a pending
                // attachment row re-imports/re-validates through the seam).
            }
        }
    }

    // Insert or refresh the ledger row (accepted path only).
    let prior_submitted = matches!(
        ledger.inbound_entry(&event.account, &event.external_message_id),
        Some(e) if e.state == InboundState::Submitted
    );
    let entry = InboundEntry {
        transport_account: event.account.clone(),
        external_message_id: event.external_message_id.clone(),
        references_external_message_id: event.references_external_message_id.clone(),
        state: InboundState::Received,
        event_kind: event.event_kind,
        session_id: session_id.clone(),
        external_conversation_id: event.external_conversation_id.clone(),
        channel_id: event.channel_id.clone(),
        sender_class: event.sender_class.clone(),
        received_at: now.clone(),
        ingress_key: ingress_key.clone(),
        operation_digest: operation_digest.clone(),
        block_id: None,
        attachments: attachment_records,
        pages: config.target_page_ids.clone(),
        config_revision: config.revision,
        attempts: vec![AttemptRecord {
            at: now.clone(),
            kind: "submit".to_string(),
            detail_digest: operation_digest.clone(),
        }],
        request_jcs: request_jcs.clone(),
        rejected_code: None,
    };
    if ledger
        .insert_inbound(entry, config.ledger_bounds.inbound_max_entries)
        .is_err()
    {
        return reject_before_mutation(ChannelError::new(
            codes::LEDGER_FULL,
            false,
            ChannelOutcome::NotApplied,
            "inbound ledger is at capacity",
        ));
    }

    // Crash recovery: a prior `submitted` row had a lost response; reconcile
    // through status BEFORE resubmitting.
    if prior_submitted {
        match core.status(
            &request.operation_id,
            &request.module_id,
            &request.idempotency_key,
            &request.deadline,
        ) {
            Ok(IngressStatusResult::Committed { commit }) => {
                settle_accepted(ledger, event, &commit, &now);
                return IngressOutcome::Committed {
                    block_id: commit.block_id.clone(),
                    idempotent: true,
                    ingress_id: commit.ingress_id.clone(),
                };
            }
            Ok(IngressStatusResult::Absent) => {}
            Err(_) => {
                // Status also lost; remain submitted and pending.
                mark_submitted(ledger, event);
                return IngressOutcome::SubmissionPending;
            }
        }
    }

    match core.submit(&request) {
        Ok(IngressSubmitReceipt::Committed { idempotent, commit }) => {
            settle_accepted(ledger, event, &commit, &now);
            IngressOutcome::Committed {
                block_id: commit.block_id.clone(),
                idempotent,
                ingress_id: commit.ingress_id.clone(),
            }
        }
        Err(CoreIngressError::UnknownOutcome) | Err(CoreIngressError::Unavailable) => {
            // Response lost: mark submitted; the durable Core outcome is
            // unknown and MUST be reconciled before replay.
            mark_submitted(ledger, event);
            IngressOutcome::SubmissionPending
        }
        Err(CoreIngressError::Rejected { code }) => {
            if let Some(existing) =
                ledger.inbound_get_mut(&event.account, &event.external_message_id)
            {
                existing.state = InboundState::Rejected;
                existing.rejected_code = Some(code.clone());
                existing.attempts.push(AttemptRecord {
                    at: now.clone(),
                    kind: "reject".to_string(),
                    detail_digest: digest_of(&code),
                });
            }
            IngressOutcome::CoreRejected {
                error: ChannelError::new(
                    codes::OPERATION_CONFLICT,
                    false,
                    ChannelOutcome::NotApplied,
                    format!("Core rejected ingress submission: {code}"),
                ),
            }
        }
    }
}

fn mark_submitted(ledger: &mut ChannelLedger, event: &InboundEvent) {
    if let Some(existing) = ledger.inbound_get_mut(&event.account, &event.external_message_id) {
        existing.state = InboundState::Submitted;
    }
}

fn settle_accepted(
    ledger: &mut ChannelLedger,
    event: &InboundEvent,
    commit: &IngressCommit,
    now: &str,
) {
    if let Some(existing) = ledger.inbound_get_mut(&event.account, &event.external_message_id) {
        existing.state = InboundState::Accepted;
        existing.block_id = Some(commit.block_id.clone());
        existing.attempts.push(AttemptRecord {
            at: now.to_string(),
            kind: "accepted".to_string(),
            detail_digest: digest_of(&commit.block_id),
        });
    }
}

/// Reconcile every inbound row whose submit outcome was lost (state
/// `submitted`): query `status`; a committed row is settled to `accepted`
/// with its prior mapping, and only an authoritative `absent` replays the
/// byte-identical request. Rows that remain unknown stay `submitted`.
///
/// Returns the number of rows left unresolved.
pub fn reconcile_inbound<E: CoreIngress>(
    config: &ChannelConfig,
    clock: &dyn Clock,
    ledger: &mut ChannelLedger,
    core: &mut E,
) -> usize {
    let keys: Vec<(String, String)> = ledger
        .inbound
        .values()
        .filter(|e| e.state == InboundState::Submitted)
        .map(|e| (e.transport_account.clone(), e.external_message_id.clone()))
        .collect();
    let deadline = timestamp_plus_seconds(
        clock.now().as_str(),
        config.operation_deadline_seconds as i64,
    );
    for (account, external_message_id) in keys {
        let Some(entry) = ledger.inbound_entry(&account, &external_message_id) else {
            continue;
        };
        let operation_id = ids::operation_id(&account, &external_message_id, 1);
        let module_id = config.module_id.clone();
        let idempotency_key = entry.ingress_key.clone();
        match core.status(&operation_id, &module_id, &idempotency_key, &deadline) {
            Ok(IngressStatusResult::Committed { commit }) => {
                let now = clock.now().as_str().to_string();
                if let Some(existing) = ledger.inbound_get_mut(&account, &external_message_id) {
                    existing.state = InboundState::Accepted;
                    existing.block_id = Some(commit.block_id.clone());
                    existing.attempts.push(AttemptRecord {
                        at: now.clone(),
                        kind: "reconcile".to_string(),
                        detail_digest: digest_of(&commit.block_id),
                    });
                }
            }
            Ok(IngressStatusResult::Absent) => {
                // Authoritative absent: replay the byte-identical request only.
                // The stored request_jcs is the canonical draft; rebuilding it
                // must reproduce the exact canonical bytes or the row stays
                // submitted.
                let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&entry.request_jcs)
                else {
                    continue;
                };
                let Ok(draft) = CanonicalJsonValue::try_from(parsed) else {
                    continue;
                };
                let Ok(bytes) = draft_canonical_string(&draft) else {
                    continue;
                };
                if bytes != entry.request_jcs {
                    continue;
                }
                let request = IngressSubmitRequest {
                    operation_id: ids::operation_id(&account, &external_message_id, 2),
                    module_id: module_id.clone(),
                    idempotency_key: idempotency_key.clone(),
                    draft,
                    target_page_ids: entry.pages.clone(),
                    deadline: deadline.clone(),
                };
                if let Ok(IngressSubmitReceipt::Committed { commit, .. }) = core.submit(&request) {
                    let now = clock.now().as_str().to_string();
                    if let Some(existing) = ledger.inbound_get_mut(&account, &external_message_id) {
                        existing.state = InboundState::Accepted;
                        existing.block_id = Some(commit.block_id.clone());
                        existing.attempts.push(AttemptRecord {
                            at: now.clone(),
                            kind: "replay".to_string(),
                            detail_digest: digest_of(&commit.block_id),
                        });
                    }
                }
            }
            Err(_) => {}
        }
    }
    ledger
        .inbound
        .values()
        .filter(|e| e.state == InboundState::Submitted)
        .count()
}
