//! Stable asset service error codes and the common error envelope.
//!
//! Codes follow the Asset Service specification §10. `phase`, `import_id`,
//! and optional `asset_id` are carried inside `details`, never as extra
//! top-level fields, and the envelope matches `error.schema.json`.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Stable asset error codes (specification §10 "Stable codes include...").
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AssetErrorCode {
    /// The source kind, destination, capability, or security domain was denied.
    SourceDenied,
    /// The source could not be reached or was exhausted early.
    SourceUnavailable,
    /// Encoded or decoded bytes exceeded an enforced bound.
    SizeLimit,
    /// Strict base64 decoding failed.
    InvalidBase64,
    /// Declared and detected media types disagree materially.
    MediaTypeMismatch,
    /// Content failed a decoder-safety or content-policy gate.
    UnsafeMedia,
    /// A computed digest did not match the recorded one.
    HashMismatch,
    /// EXIF orientation was present but outside 1..=8.
    InvalidOrientation,
    /// A normalized crop rectangle was invalid.
    InvalidCrop,
    /// A crop became empty after decoder bounds checks.
    EmptyCrop,
    /// The content-addressed local store could not accept bytes.
    StorageFull,
    /// A required object-store replica failed and the import is non-available.
    RemoteReplicaFailed,
    /// The same `ImportId` was reused with different parameters.
    ImportIdConflict,
    /// The request or one of its fields failed closed validation.
    InvalidRequest,
    /// An unknown source kind was supplied.
    UnknownSourceKind,
    /// The caller held no authority for the requested operation or domain.
    Unauthorized,
    /// The asset does not exist, is not available, or is not in the domain.
    NotFound,
    /// The asset lifecycle is tombstoned; no new lease or reference may attach.
    Tombstoned,
    /// A lease has already expired or is invalid.
    LeaseInvalid,
    /// An internal invariant failed; no caller-state is implied.
    Internal,
}

impl AssetErrorCode {
    /// Whether a retry of the same request has a plausible chance to succeed.
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            AssetErrorCode::SourceUnavailable
                | AssetErrorCode::StorageFull
                | AssetErrorCode::RemoteReplicaFailed
                | AssetErrorCode::Internal
        )
    }
}

impl fmt::Display for AssetErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            AssetErrorCode::SourceDenied => "SOURCE_DENIED",
            AssetErrorCode::SourceUnavailable => "SOURCE_UNAVAILABLE",
            AssetErrorCode::SizeLimit => "SIZE_LIMIT",
            AssetErrorCode::InvalidBase64 => "INVALID_BASE64",
            AssetErrorCode::MediaTypeMismatch => "MEDIA_TYPE_MISMATCH",
            AssetErrorCode::UnsafeMedia => "UNSAFE_MEDIA",
            AssetErrorCode::HashMismatch => "HASH_MISMATCH",
            AssetErrorCode::InvalidOrientation => "INVALID_ORIENTATION",
            AssetErrorCode::InvalidCrop => "INVALID_CROP",
            AssetErrorCode::EmptyCrop => "EMPTY_CROP",
            AssetErrorCode::StorageFull => "STORAGE_FULL",
            AssetErrorCode::RemoteReplicaFailed => "REMOTE_REPLICA_FAILED",
            AssetErrorCode::ImportIdConflict => "IMPORT_ID_CONFLICT",
            AssetErrorCode::InvalidRequest => "INVALID_REQUEST",
            AssetErrorCode::UnknownSourceKind => "UNKNOWN_SOURCE_KIND",
            AssetErrorCode::Unauthorized => "UNAUTHORIZED",
            AssetErrorCode::NotFound => "NOT_FOUND",
            AssetErrorCode::Tombstoned => "TOMBSTONED",
            AssetErrorCode::LeaseInvalid => "LEASE_INVALID",
            AssetErrorCode::Internal => "INTERNAL",
        };
        f.write_str(text)
    }
}

/// The import phase that produced an error, for `details.phase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorPhase {
    Validate,
    Accept,
    Acquire,
    Verify,
    Commit,
    Replicate,
    Recover,
    Retain,
    Collect,
}

/// Asset-specific fields placed inside the error envelope `details`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetErrorDetails {
    #[serde(rename = "phase")]
    pub phase: ErrorPhase,
    #[serde(rename = "import_id", skip_serializing_if = "Option::is_none")]
    pub import_id: Option<String>,
    #[serde(rename = "asset_id", skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
}

/// The common error envelope for asset operations (error.schema.json shape).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetErrorEnvelope {
    pub code: String,
    pub retryable: bool,
    pub outcome: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    pub details: AssetErrorDetails,
}

/// The crate-internal typed asset failure.
#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub struct AssetError {
    pub code: AssetErrorCode,
    pub message: String,
    pub phase: ErrorPhase,
    pub import_id: Option<String>,
    pub asset_id: Option<String>,
    /// Internal-only cause text; never emitted into a wire envelope.
    #[source]
    pub cause: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl AssetError {
    pub fn new(code: AssetErrorCode, phase: ErrorPhase, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            phase,
            import_id: None,
            asset_id: None,
            cause: None,
        }
    }

    pub fn with_import_id(mut self, import_id: impl Into<String>) -> Self {
        self.import_id = Some(import_id.into());
        self
    }

    pub fn with_asset_id(mut self, asset_id: impl Into<String>) -> Self {
        self.asset_id = Some(asset_id.into());
        self
    }

    /// The wire envelope. `outcome` follows the error contract: `not_applied`
    /// for validation/denials before any mutation, `unknown` for failures
    /// after a durable mutation that may or may not have taken effect.
    pub fn to_envelope(&self) -> AssetErrorEnvelope {
        AssetErrorEnvelope {
            code: self.code.to_string(),
            retryable: self.code.retryable(),
            outcome: match self.phase {
                ErrorPhase::Validate | ErrorPhase::Acquire | ErrorPhase::Verify => "not_applied",
                ErrorPhase::Commit | ErrorPhase::Replicate | ErrorPhase::Recover => "unknown",
                _ => "not_applied",
            }
            .to_string(),
            message: self.message.clone(),
            correlation_id: None,
            details: AssetErrorDetails {
                phase: self.phase,
                import_id: self.import_id.clone(),
                asset_id: self.asset_id.clone(),
            },
        }
    }
}

pub type AssetResult<T> = Result<T, AssetError>;
