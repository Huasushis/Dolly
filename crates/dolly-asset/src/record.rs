//! Durable import, asset, retention, and wire record shapes.
//!
//! The import state machine and its exact allowed transitions follow the
//! Asset Service specification §4. Records here are plain serde shapes held
//! by the store; the store is the only authority that persists them.

use crate::identity::{AssetId, AssetRef, ContentHash, MediaType};
use serde::{Deserialize, Serialize};

/// The import state machine (specification §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportState {
    Accepted,
    Acquiring,
    Verifying,
    Committing,
    Replicating,
    ReplicaFailed,
    Available,
    Rejected,
    Cancelled,
}

impl ImportState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            ImportState::Available | ImportState::Rejected | ImportState::Cancelled
        )
    }

    /// The exact allowed forward and crash-recovery transitions (spec §4).
    pub fn allows(self, next: ImportState) -> bool {
        use ImportState::*;
        matches!(
            (self, next),
            (Accepted, Acquiring | Rejected | Cancelled)
                | (Acquiring, Accepted | Verifying | Rejected | Cancelled)
                | (Verifying, Accepted | Committing | Rejected | Cancelled)
                | (Committing, Accepted | Available | Replicating | Rejected | Cancelled)
                | (Replicating, Available | ReplicaFailed | Cancelled)
                | (ReplicaFailed, Replicating | Rejected | Cancelled)
        )
    }
}

/// Wire name of the state (asset-status.schema.json `state` enum).
impl ImportState {
    pub fn wire_name(self) -> &'static str {
        match self {
            ImportState::Accepted => "accepted",
            ImportState::Acquiring => "acquiring",
            ImportState::Verifying => "verifying",
            ImportState::Committing => "committing",
            ImportState::Replicating => "replicating",
            ImportState::ReplicaFailed => "replica_failed",
            ImportState::Available => "available",
            ImportState::Rejected => "rejected",
            ImportState::Cancelled => "cancelled",
        }
    }
}

/// Local-store and replica presence states (spec §2, §8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalState {
    Present,
    Missing,
    Quarantined,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplicaState {
    Disabled,
    PendingUpload,
    Present,
    UploadFailed,
    PendingDelete,
    DeleteFailed,
    Deleted,
}

impl Default for ReplicaState {
    fn default() -> Self {
        ReplicaState::Disabled
    }
}

impl ReplicaState {
    pub fn wire_name(self) -> &'static str {
        match self {
            ReplicaState::Disabled => "disabled",
            ReplicaState::PendingUpload => "pending_upload",
            ReplicaState::Present => "present",
            ReplicaState::UploadFailed => "upload_failed",
            ReplicaState::PendingDelete => "pending_delete",
            ReplicaState::DeleteFailed => "delete_failed",
            ReplicaState::Deleted => "deleted",
        }
    }
}

/// One durable import record (spec §4 `ImportRecord`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportRecord {
    pub import_id: String,
    pub instance_id: String,
    pub module_id: String,
    pub security_domain: String,
    pub state: ImportState,
    /// JCS digest of the accepted request parameters, for idempotent replay.
    pub params_digest: String,
    pub media_kind: String,
    pub source_kind: String,
    pub source_json: String,
    pub declared_media_type: Option<String>,
    pub expected_byte_length: Option<u64>,
    pub remote_required: bool,
    pub deadline: String,
    pub max_bytes: u64,
    pub asset_id: Option<String>,
    pub detected_media_type: Option<String>,
    pub byte_length: Option<u64>,
    pub encoded_width: Option<u64>,
    pub encoded_height: Option<u64>,
    pub orientation: Option<u8>,
    pub staging_bytes: Option<u64>,
    pub staging_hash: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub error_retryable: Option<bool>,
    pub error_outcome: Option<String>,
    pub error_details_json: Option<String>,
    pub replica_state: ReplicaState,
    pub replica_attempt: u64,
    pub retry_at_ms: Option<u64>,
    pub created_at: String,
    pub updated_at: String,
    pub updated_at_ms: u64,
}

impl ImportRecord {
    pub fn staging_key(&self) -> String {
        format!("staging-{}", self.import_id)
    }

    /// Build the downstream-safe reference for an `AVAILABLE` record. Fails
    /// closed: any non-canonical recorded value yields `None` rather than a
    /// reference a consumer could mistake for authority.
    pub fn asset_ref(&self) -> Option<AssetRef> {
        let asset_id = self.asset_id.as_ref()?;
        let byte_length = self.byte_length?;
        let media_type = MediaType::parse(
            self.detected_media_type
                .as_deref()
                .unwrap_or("application/octet-stream"),
        )
        .ok()?;
        let reference = AssetRef {
            asset_id: asset_id.parse().ok()?,
            media_type,
            byte_length,
            orientation: self.orientation,
            encoded_width: self.encoded_width,
            encoded_height: self.encoded_height,
            display_width: self.display_width(),
            display_height: self.display_height(),
        };
        // Fail closed: a record can never mint a non-canonical reference.
        reference.validate().ok()?;
        Some(reference)
    }

    /// Upright display dimensions: swap axes for orientations 5..=8.
    fn display_width(&self) -> Option<u64> {
        let (w, h) = (self.encoded_width?, self.encoded_height?);
        match self.orientation {
            Some(5..=8) => Some(h),
            _ => Some(w),
        }
    }

    fn display_height(&self) -> Option<u64> {
        let (w, h) = (self.encoded_width?, self.encoded_height?);
        match self.orientation {
            Some(5..=8) => Some(w),
            _ => Some(h),
        }
    }
}

/// A durable asset lifecycle row keyed by (asset_id, security_domain,
/// generation). Generations allow a tombstoned asset to be reimported as a
/// new live lifecycle with the same content-derived `AssetId`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetRecord {
    pub asset_id: String,
    pub security_domain: String,
    pub generation: u64,
    pub content_hash: ContentHash,
    pub byte_length: u64,
    pub declared_media_type: Option<String>,
    pub detected_media_type: Option<String>,
    pub orientation: Option<u8>,
    pub encoded_width: Option<u64>,
    pub encoded_height: Option<u64>,
    pub display_width: Option<u64>,
    pub display_height: Option<u64>,
    pub lifecycle: Lifecycle,
    pub deletion_generation: u64,
    pub local_state: LocalState,
    pub replica_state: ReplicaState,
    pub tombstoned_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub updated_at_ms: u64,
}

impl AssetRecord {
    /// Build the downstream-safe canonical reference from an asset row.
    /// Fails closed: any non-canonical recorded value yields `None` rather
    /// than a reference a consumer could mistake for authority.
    pub fn asset_ref(&self) -> Option<AssetRef> {
        let byte_length = self.byte_length;
        let media_type = MediaType::parse(
            self.detected_media_type
                .as_deref()
                .unwrap_or("application/octet-stream"),
        )
        .ok()?;
        let reference = AssetRef {
            asset_id: self.asset_id.parse().ok()?,
            media_type,
            byte_length,
            orientation: self.orientation,
            encoded_width: self.encoded_width,
            encoded_height: self.encoded_height,
            display_width: self.display_width,
            display_height: self.display_height,
        };
        reference.validate().ok()?;
        Some(reference)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lifecycle {
    Live,
    Tombstoned,
}

/// A durable reference owned by a committed Block, retained Page delivery,
/// Memory record, or derived asset (spec §7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetReference {
    pub asset_id: String,
    pub security_domain: String,
    pub generation: u64,
    pub ref_key: String,
    pub owner: String,
    pub created_at: String,
}

/// A temporary lease with finite expiry (spec §7). Never silently converted
/// to a pin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetLease {
    pub lease_id: String,
    pub asset_id: String,
    pub security_domain: String,
    pub generation: u64,
    pub owner: String,
    pub purpose: String,
    pub created_at: String,
    pub expires_at: String,
    pub expires_at_ms: u64,
}

/// A durable pin carrying a reason; expiry-less pins require a privileged
/// capability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetPin {
    pub pin_id: String,
    pub asset_id: String,
    pub security_domain: String,
    pub generation: u64,
    pub owner: String,
    pub reason: String,
    pub privileged: bool,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub expires_at_ms: Option<u64>,
}

/// An audit tombstone: identity, timestamps, sizes, and deletion outcome only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetTombstone {
    pub asset_id: String,
    pub security_domain: String,
    pub generation: u64,
    pub deletion_generation: u64,
    pub content_hash: String,
    pub byte_length: u64,
    pub local_outcome: String,
    pub deleted_at: String,
}

// ---------------------------------------------------------------------------
// Wire request and result shapes
// ---------------------------------------------------------------------------

/// `media_kind` values (asset-import.schema.json).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Audio,
    Video,
    File,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKind::Image => "image",
            MediaKind::Audio => "audio",
            MediaKind::Video => "video",
            MediaKind::File => "file",
        }
    }
}

/// One accepted import source (asset-import.schema.json `source.oneOf`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Source {
    InlineBase64 { base64: String },
    RemoteUrl { url: String, max_bytes: u64 },
    ModuleFile { file_capability: String },
    ExistingAsset { asset_id: AssetId },
    Stream { stream_capability: String, max_bytes: u64 },
}

impl Source {
    pub fn kind_name(&self) -> &'static str {
        match self {
            Source::InlineBase64 { .. } => "inline_base64",
            Source::RemoteUrl { .. } => "remote_url",
            Source::ModuleFile { .. } => "module_file",
            Source::ExistingAsset { .. } => "existing_asset",
            Source::Stream { .. } => "stream",
        }
    }

    /// The per-import positive byte bound, when the source carries one.
    pub fn declared_max_bytes(&self) -> Option<u64> {
        match self {
            Source::RemoteUrl { max_bytes, .. } | Source::Stream { max_bytes, .. } => {
                Some(*max_bytes)
            }
            _ => None,
        }
    }
}

/// The preprocessed `host.asset.import` input
/// (asset-import.schema.json).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportRequest {
    pub import_id: String,
    pub instance_id: String,
    pub module_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_token: Option<String>,
    pub media_kind: MediaKind,
    pub source: Source,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub declared_media_type: Option<MediaType>,
    pub remote_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_byte_length: Option<u64>,
    pub deadline: String,
}

/// `host.asset.import` / `host.asset.status` result
/// (asset-status.schema.json).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusResult {
    pub import_id: String,
    pub state: String,
    pub terminal: bool,
    pub asset: Option<AssetRef>,
    pub error: Option<serde_json::Value>,
}

impl StatusResult {
    /// The closed not-found status for an unknown or unauthorized
    /// `ImportId`. Only this outcome authorizes replay of a byte-identical
    /// import. It never carries an `AssetRef` and never mirrors a lifecycle
    /// state the import never reached, so a caller cannot mistake it for any
    /// recorded state.
    pub fn absent(import_id: impl Into<String>) -> Self {
        StatusResult {
            import_id: import_id.into(),
            state: "absent".to_string(),
            terminal: false,
            asset: None,
            error: None,
        }
    }

    pub fn from_record(record: &ImportRecord) -> Self {
        let state = record.state.wire_name().to_string();
        let terminal = record.state.is_terminal();
        let asset = if record.state == ImportState::Available {
            record.asset_ref()
        } else {
            None
        };
        let error = match (record.state, &record.error_code) {
            (ImportState::ReplicaFailed | ImportState::Rejected, Some(_)) => Some(
                crate::error::AssetErrorEnvelope {
                    code: record.error_code.clone().unwrap(),
                    retryable: record.error_retryable.unwrap_or(false),
                    outcome: record
                        .error_outcome
                        .clone()
                        .unwrap_or_else(|| "not_applied".to_string()),
                    message: record.error_message.clone().unwrap_or_default(),
                    correlation_id: None,
                    details: crate::error::AssetErrorDetails {
                        phase: crate::error::ErrorPhase::Acquire,
                        import_id: Some(record.import_id.clone()),
                        asset_id: record.asset_id.clone(),
                    },
                }
                .into_serde_json(),
            ),
            _ => None,
        };
        StatusResult {
            import_id: record.import_id.clone(),
            state,
            terminal,
            asset,
            error,
        }
    }
}

impl crate::error::AssetErrorEnvelope {
    /// Serialize the envelope to the generic JSON `error` slot of StatusResult.
    fn into_serde_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}
