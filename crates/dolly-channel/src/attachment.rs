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

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use dolly_schema::CropRect;

use crate::asset::{AssetRef, MediaKind, MediaType, media_kind_of_type};
use crate::error::{ChannelError, ChannelOutcome, codes};

/// One typed provider attachment of an authenticated inbound event. Carries
/// only attachment identity/bounds — never an account, owner, path, or
/// caller authority claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InboundAttachment {
    /// The zero-based attachment index inside the event (order is part of
    /// the draft: parts follow attachment order exactly).
    pub ordinal: u32,
    /// The bounded opaque provider attachment identity.
    pub provider_key: String,
    /// Closed provider-declared kind. It must agree with the declared type.
    pub media_kind: MediaKind,
    /// Canonical provider-declared type. Asset's authoritative detected type
    /// must agree before the attachment can become available.
    pub declared_media_type: MediaType,
    /// Positive provider-declared byte bound; authoritative bytes must remain
    /// within the Channel configuration bound.
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

/// The exact canonical Asset result permitted in a Block draft.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AvailableAttachment {
    pub asset_ref: AssetRef,
    pub media_kind: MediaKind,
    /// Optional normalized crop carried by the draft part.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<CropRect>,
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
#[serde(deny_unknown_fields)]
pub struct AttachmentImportRequest {
    /// Channel account-scoped idempotency key for the Asset import.
    pub attachment_key: String,
    pub provider_key: String,
    pub media_kind: MediaKind,
    pub declared_media_type: MediaType,
    pub byte_length_hint: u64,
}

impl AttachmentImportRequest {
    /// The account-scoped idempotency key of one attachment import.
    pub fn new(account: &str, event_key: &str, attachment: &InboundAttachment) -> Self {
        Self {
            attachment_key: format!("{account}\u{0}{event_key}\u{0}{}", attachment.ordinal),
            provider_key: attachment.provider_key.clone(),
            media_kind: attachment.media_kind,
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
    /// Authoritative Asset status: this exact `attachment_key` has no durable
    /// import record or effect. Only the Runtime Asset adapter may report
    /// this; Channel errors are never converted to `Absent`.
    Absent,
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
    fn import(
        &mut self,
        request: &AttachmentImportRequest,
    ) -> Result<AttachmentImportStatus, ChannelError>;

    /// The exact status of one previously-requested import. `Absent` alone
    /// authorizes Channel to replay this same request/key during recovery.
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

/// Closed validation of every authenticated attachment field before any
/// durable write or Asset import.
pub(crate) fn validate_attachment_sequence(
    attachments: &[InboundAttachment],
    max_attachments: usize,
    max_asset_bytes: u64,
) -> Result<(), ChannelError> {
    let malformed = |message: String| {
        ChannelError::new(
            codes::MALFORMED_EVENT,
            false,
            ChannelOutcome::NotApplied,
            message,
        )
    };
    if attachments.len() > max_attachments {
        return Err(malformed(format!(
            "attachment count {} exceeds the configured maximum {max_attachments}",
            attachments.len()
        )));
    }
    let mut provider_keys = BTreeSet::new();
    for (expected, attachment) in attachments.iter().enumerate() {
        if attachment.ordinal as usize != expected {
            return Err(malformed(
                "attachment ordinals must be exact and contiguous from zero".to_string(),
            ));
        }
        if attachment.provider_key.is_empty()
            || attachment.provider_key.len() > crate::ingress::MAX_EXTERNAL_ID_BYTES
            || attachment
                .provider_key
                .chars()
                .any(|character| character.is_control() || is_noncharacter(character))
        {
            return Err(malformed(
                "attachment provider identity is empty, oversized, or unsafe".to_string(),
            ));
        }
        if !provider_keys.insert(attachment.provider_key.as_str()) {
            return Err(malformed(
                "attachment provider identities must be unique within an event".to_string(),
            ));
        }
        if attachment.media_kind != media_kind_of_type(&attachment.declared_media_type) {
            return Err(malformed(format!(
                "attachment {} kind does not match declared type {}",
                attachment.ordinal, attachment.declared_media_type
            )));
        }
        if attachment.byte_length_hint == 0 || attachment.byte_length_hint > max_asset_bytes {
            return Err(malformed(format!(
                "attachment {} byte bound is outside 1..={max_asset_bytes}",
                attachment.ordinal
            )));
        }
    }
    Ok(())
}

/// Validate one newly available Asset result against the persisted intent.
pub(crate) fn validate_available_attachment(
    attachment: &InboundAttachment,
    available: &AvailableAttachment,
    max_asset_bytes: u64,
) -> Result<(), ChannelError> {
    available.asset_ref.validate().map_err(|message| {
        ChannelError::new(
            codes::MALFORMED_EVENT,
            false,
            ChannelOutcome::NotApplied,
            format!("available attachment has an invalid AssetRef: {message}"),
        )
    })?;
    if available.media_kind != attachment.media_kind
        || available.media_kind != media_kind_of_type(&available.asset_ref.media_type)
        || available.asset_ref.media_type != attachment.declared_media_type
    {
        return Err(ChannelError::new(
            codes::MALFORMED_EVENT,
            false,
            ChannelOutcome::NotApplied,
            "available attachment kind/type does not match the persisted intent",
        ));
    }
    if available.asset_ref.byte_length > max_asset_bytes
        || available.asset_ref.byte_length > attachment.byte_length_hint
    {
        return Err(ChannelError::new(
            codes::MALFORMED_EVENT,
            false,
            ChannelOutcome::NotApplied,
            "available attachment byte length exceeds its persisted bound",
        ));
    }
    Ok(())
}

fn is_noncharacter(character: char) -> bool {
    let value = character as u32;
    (0xfdd0..=0xfdef).contains(&value) || value & 0xffff == 0xfffe || value & 0xffff == 0xffff
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_key_is_account_scoped_and_ordered() {
        let a = InboundAttachment {
            ordinal: 0,
            provider_key: "pk-1".to_string(),
            media_kind: MediaKind::Image,
            declared_media_type: MediaType::parse("image/png").unwrap(),
            byte_length_hint: 1000,
        };
        let key_a = AttachmentImportRequest::new("acct-a", "evt-x", &a);
        let key_b = AttachmentImportRequest::new("acct-b", "evt-x", &a);
        assert_ne!(key_a.attachment_key, key_b.attachment_key);
        assert!(key_a.attachment_key.starts_with("acct-a"));
        let other = InboundAttachment {
            ordinal: 1,
            ..a.clone()
        };
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
                media_kind: MediaKind::Image,
                declared_media_type: MediaType::parse("image/png").unwrap(),
                byte_length_hint: 1,
            },
        );
        let error = seam.import(&request).expect_err("attachments refused");
        assert_eq!(error.code, codes::UNSUPPORTED_MODALITY);
        let status_error = seam.status(&request).expect_err("status refused");
        assert_eq!(status_error.code, codes::UNSUPPORTED_MODALITY);
    }

    #[test]
    fn sequence_validation_closes_kind_identity_order_and_size() {
        let valid = InboundAttachment {
            ordinal: 0,
            provider_key: "provider-1".to_string(),
            media_kind: MediaKind::Image,
            declared_media_type: MediaType::parse("image/png").unwrap(),
            byte_length_hint: 4,
        };
        assert!(validate_attachment_sequence(&[valid.clone()], 1, 4).is_ok());
        let wrong_kind = InboundAttachment {
            media_kind: MediaKind::Audio,
            ..valid.clone()
        };
        assert!(validate_attachment_sequence(&[wrong_kind], 1, 4).is_err());
        let duplicate = InboundAttachment {
            ordinal: 1,
            ..valid.clone()
        };
        assert!(validate_attachment_sequence(&[valid.clone(), duplicate], 2, 4).is_err());
        let unsafe_identity = InboundAttachment {
            provider_key: "bad\u{0}key".to_string(),
            ..valid
        };
        assert!(validate_attachment_sequence(&[unsafe_identity], 1, 4).is_err());
    }
}
