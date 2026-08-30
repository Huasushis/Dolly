//! Inbound attachment boundary (WP-013B inbound multimodal).
//!
//! One authenticated external event may carry typed provider attachments.
//! Each attachment is an explicit premise: an opaque transport-side
//! `provider_key`, a declared canonical `media_type`, and a bounded byte
//! hint. The Channel never mints an AssetRef, never reads a path or raw
//! bytes, and never imports through any store directly: every attachment is
//! handed to the single sealed injected [`InboundAssetImport`] seam (sole
//! integrator: the Host/Runtime), which performs the explicit Asset import
//! through the Asset service and returns the durable Asset service premise
//! (or pending/refused). The Channel persists the per-attachment state and
//! emits the inbound Block draft only when every required asset is
//! `Available` under the correct owner/domain; a refusal is represented
//! explicitly and never as a fabricated reference.

use serde::{Deserialize, Serialize};

use dolly_schema::CropRect;

use crate::error::{ChannelError, ChannelOutcome, codes};

/// One typed provider attachment of an authenticated inbound event. Carries
/// only attachment identity/bounds — never an account, owner, path, or
/// caller authority claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboundAttachment {
    /// The zero-based attachment index inside the event (order is part of
    /// the draft: parts follow attachment order exactly).
    pub ordinal: u32,
    /// The transport-side attachment identity (bounded, opaque).
    pub provider_key: String,
    /// The transport-declared canonical media type (a hint only; the
    /// authoritative detected type comes from the Asset service result).
    pub declared_media_type: String,
    /// The transport-declared byte bound (a hint only; the Asset service
    /// bounds the real import).
    pub byte_length_hint: u64,
}

/// Normative per-attachment import state in the inbound ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentState {
    /// The Asset import has not produced an AVAILABLE result yet.
    Pending,
    /// The asset is AVAILABLE under the Channel owner/domain with canonical
    /// results; the Block draft may reference it.
    Available,
    /// The import was durably refused; the event is represented explicitly
    /// as failed, never as a fabricated reference.
    Refused,
}

impl AttachmentState {
    pub fn as_str(self) -> &'static str {
        match self {
            AttachmentState::Pending => "pending",
            AttachmentState::Available => "available",
            AttachmentState::Refused => "refused",
        }
    }
}

/// The canonical result of a successful import: identity only (the exact
/// reference the Block draft may carry), never a path or store identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AvailableAttachment {
    pub asset_id: String,
    /// Authoritative detected media type from the Asset record.
    pub media_type: String,
    /// Optional normalized crop carried by the draft part.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<CropRect>,
    pub byte_length: u64,
    pub content_digest: String,
}

/// The per-attachment durable ledger state of one inbound event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentRecord {
    pub attachment: InboundAttachment,
    pub state: AttachmentState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available: Option<AvailableAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused_code: Option<String>,
}

/// The explicit Asset import request handed to the injected seam for one
/// provider attachment. The `attachment_key` is the Channel's
/// account-scoped idempotency key (binds provider key + declared metadata).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentImportRequest {
    /// Channel account-scoped idempotency key for the Asset import.
    pub attachment_key: String,
    pub provider_key: String,
    pub declared_media_type: String,
    pub byte_length_hint: u64,
}

impl AttachmentImportRequest {
    /// The account-scoped idempotency key of one attachment import (reusing
    /// an external provider key in another account never collides).
    pub fn new(account: &str, event_key: &str, attachment: &InboundAttachment) -> Self {
        Self {
            attachment_key: format!("{account}\u{0}{event_key}\u{0}{}", attachment.ordinal),
            provider_key: attachment.provider_key.clone(),
            declared_media_type: attachment.declared_media_type.clone(),
            byte_length_hint: attachment.byte_length_hint,
        }
    }
}

/// The exact Asset service import result for one attachment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachmentImportStatus {
    /// The import is in progress; the Channel persists `pending`.
    Pending,
    /// The asset is AVAILABLE under the correct owner/domain.
    Available(AvailableAttachment),
    /// The import was refused; the event fails explicitly.
    Refused { code: String },
}

/// The single sealed injected inbound Asset import seam (sole integrator:
/// the Host/Runtime). It performs provider-attachment -> explicit Asset
/// import -> durable Asset service premise/result; the Channel never mints
/// an AssetRef and never accesses the store or a path directly.
pub trait InboundAssetImport {
    /// Import (or replay) one attachment through the Asset service and
    /// return its exact result. Deterministic per `attachment_key`.
    fn import(&mut self, request: &AttachmentImportRequest)
        -> Result<AttachmentImportStatus, ChannelError>;

    /// The exact status of one previously-requested import (recovery path;
    /// never re-imports blindly).
    fn status(
        &mut self,
        request: &AttachmentImportRequest,
    ) -> Result<AttachmentImportStatus, ChannelError>;
}

/// Default fail-closed seam: the accepted v1 text-only profile. Any
/// attachment is refused with `CHANNEL_UNSUPPORTED_MODALITY` before any
/// durable or transport effect; only an explicitly injected integrator seam
/// may enable attachments.
#[derive(Debug, Clone, Copy, Default)]
pub struct DenyAttachments;

impl InboundAssetImport for DenyAttachments {
    fn import(
        &mut self,
        request: &AttachmentImportRequest,
    ) -> Result<AttachmentImportStatus, ChannelError> {
        Err(ChannelError::new(
            codes::UNSUPPORTED_MODALITY,
            false,
            ChannelOutcome::NotApplied,
            format!(
                "attachments require the WP-013B channel multimodal profile (provider key {})",
                request.provider_key
            ),
        ))
    }

    fn status(
        &mut self,
        request: &AttachmentImportRequest,
    ) -> Result<AttachmentImportStatus, ChannelError> {
        Err(ChannelError::new(
            codes::UNSUPPORTED_MODALITY,
            false,
            ChannelOutcome::NotApplied,
            format!(
                "attachment imports require the WP-013B channel multimodal profile (provider key {})",
                request.provider_key
            ),
        ))
    }
}

/// Canonical lowercase MIME media type check for the transport-declared
/// attachment media type (same grammar as the outbound boundary).
pub(crate) fn is_canonical_media_type(value: &str) -> bool {
    if value.len() < 3 || value.len() > 255 {
        return false;
    }
    let Some((top, sub)) = value.split_once('/') else {
        return false;
    };
    is_mime_token(top) && is_mime_token(sub)
}

fn is_mime_token(token: &str) -> bool {
    let bytes = token.as_bytes();
    match bytes.first() {
        Some(first) if is_mime_token_start(*first) => {}
        _ => return false,
    }
    bytes.iter().skip(1).all(|byte| is_mime_token_char(*byte))
}

fn is_mime_token_start(byte: u8) -> bool {
    matches!(byte, b'a'..=b'z' | b'0'..=b'9')
}

fn is_mime_token_char(byte: u8) -> bool {
    matches!(
        byte,
        b'a'..=b'z'
            | b'0'..=b'9'
            | b'!'
            | b'#'
            | b'$'
            | b'&'
            | b'^'
            | b'_'
            | b'.'
            | b'+'
            | b'-'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_key_is_account_scoped_and_ordered() {
        let a = InboundAttachment {
            ordinal: 0,
            provider_key: "pk-1".to_string(),
            declared_media_type: "image/png".to_string(),
            byte_length_hint: 1000,
        };
        let key_a = AttachmentImportRequest::new("acct-a", "evt-x", &a);
        let key_b = AttachmentImportRequest::new("acct-b", "evt-x", &a);
        assert_ne!(key_a.attachment_key, key_b.attachment_key);
        assert!(key_a.attachment_key.starts_with("acct-a"));
        let other = InboundAttachment { ordinal: 1, ..a.clone() };
        let key_o = AttachmentImportRequest::new("acct-a", "evt-x", &other);
        assert_ne!(key_a.attachment_key, key_o.attachment_key);
    }

    #[test]
    fn deny_seam_refuses_any_attachment() {
        let mut seam = DenyAttachments;
        let request = AttachmentImportRequest::new(
            "account-a",
            "evt-x",
            &InboundAttachment {
                ordinal: 0,
                provider_key: "pk-1".to_string(),
                declared_media_type: "image/png".to_string(),
                byte_length_hint: 1,
            },
        );
        let error = seam.import(&request).expect_err("attachments refused");
        assert_eq!(error.code, codes::UNSUPPORTED_MODALITY);
        let status_error = seam.status(&request).expect_err("status refused");
        assert_eq!(status_error.code, codes::UNSUPPORTED_MODALITY);
    }
}
