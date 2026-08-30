//! WP-013B Asset-side media preparation seam.
//!
//! `AssetService::prepare_media` turns a canonical `AssetRef` into a bounded
//! typed, digest-verified copy of the immutable bytes plus authoritative
//! metadata, guarded by the caller's exact lease. Acceptance is fail-closed:
//! only an asset whose durable lifecycle row is live and present in the
//! caller's security domain, whose current generation and recorded identity
//! exactly match the reference, and whose caller-held lease is unexpired and
//! bound to this capability's instance, domain, asset, and generation can be
//! prepared. Pending, failed, deleted, stale, revoked, foreign, and
//! non-canonical references never release bytes.
//!
//! The caller's media-kind and media-type claims are checks, never
//! authority: the result carries only the detected media type recorded at
//! import, and active document content (PDF, HTML, SVG) is refused rather
//! than relabeled. Bytes are read through the content-addressed
//! `ObjectReader` (no caller-chosen path or network), verified against the
//! recorded BLAKE3 digest, and the full lease/asset authority is revalidated
//! after the blocking read and immediately before the typed result is
//! released.

use crate::content::ObjectReader;
use crate::error::{AssetError, AssetErrorCode, ErrorPhase};
use crate::identity::{AssetRef, ContentHash, MediaType};
use crate::record::{AssetLease, AssetRecord, MediaKind};
use crate::service::AssetCapability;
use crate::store::{AssetStore, StoreTransaction};
use std::path::Path;

/// One media preparation request (the WP-013B Channel seam input).
///
/// The `asset_ref` MUST be the canonical reference minted by an `available`
/// import (or carried by a committed AssetPart); any non-canonical form is
/// refused before store access. `lease_id` is the caller-held short Asset
/// lease that must remain current through the whole preparation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaPrepareRequest {
    pub asset_ref: AssetRef,
    /// The media kind the caller claims for this part. It is a check, not a
    /// label: it MUST equal the kind derived from the authoritative detected
    /// media type.
    pub expected_media_kind: MediaKind,
    /// The media type supplied by the caller (for example from a send
    /// action). It is a check, not a label: when present it MUST equal the
    /// authoritative detected type, and it can never relabel content.
    pub claimed_media_type: Option<MediaType>,
    /// The caller-held lease guarding this read.
    pub lease_id: String,
}

/// The bounded typed result of a successful preparation.
///
/// `bytes` is an exact copy of the immutable asset bytes, capped by the
/// current decoded-byte configuration, with `digest` verified against that
/// copy before release. No path, URL, capability, or other ambient
/// authority appears in the result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedMedia {
    /// The canonical reference that was prepared.
    pub asset_ref: AssetRef,
    /// The authoritative detected media type recorded at import.
    pub media_type: MediaType,
    /// The media kind derived from the detected type, never caller-shaped.
    pub media_kind: MediaKind,
    /// The exact decoded byte count (equals `bytes.len()`).
    pub byte_length: u64,
    /// The exact current lifecycle generation that held the lease.
    pub generation: u64,
    /// The canonical BLAKE3 digest verified against `bytes`.
    pub digest: ContentHash,
    /// The lease that guarded the read; still live and current on return.
    pub lease_id: String,
    /// The verified immutable bytes, bounded by configuration.
    pub bytes: Vec<u8>,
}

/// Deterministic race control for tests. `after_read` runs in the exact
/// window between the bounded read/digest verification and the post-read
/// revalidation, so a test can revoke the lease or alter durable state and
/// prove no result escapes. Production never arms it.
pub struct PrepareFailpoint {
    pub after_read: Box<dyn FnMut(&mut AssetStore) + Send>,
}

impl PrepareFailpoint {
    pub fn new(after_read: impl FnMut(&mut AssetStore) + Send + 'static) -> Self {
        Self {
            after_read: Box::new(after_read),
        }
    }
}

/// The validated lease/asset authority snapshot shared by the pre-read
/// acceptance check and the post-read revalidation, so both enforce the
/// exact same contract.
pub(crate) struct PreparedAuthority {
    pub lease: AssetLease,
    pub asset: AssetRecord,
    pub detected_type: MediaType,
}

/// Active document content is never transportable media: it keeps its real
/// type at import and is refused here instead of being relabeled.
fn is_active_document(media_type: &MediaType) -> bool {
    matches!(
        media_type.as_str(),
        "application/pdf" | "text/html" | "image/svg+xml"
    )
}

/// The media kind derived from the authoritative detected type.
pub(crate) fn media_kind_of_type(media_type: Option<&MediaType>) -> MediaKind {
    match media_type.map(MediaType::as_str) {
        Some(s) if s.starts_with("image/") => MediaKind::Image,
        Some(s) if s.starts_with("audio/") => MediaKind::Audio,
        Some(s) if s.starts_with("video/") => MediaKind::Video,
        _ => MediaKind::File,
    }
}

/// Validate the full acceptance authority against one store snapshot.
///
/// Fail-closed ordering keeps each rejection distinct and deterministic:
/// revoked/unknown lease, foreign domain, foreign owner, lease/asset
/// mismatch, expired lease, absent or byte-missing asset, stale generation,
/// reference/record mismatch, forged kind or media type, and active document
/// content.
pub(crate) fn validate_prepare_authority(
    tx: &StoreTransaction,
    capability: &AssetCapability,
    request: &MediaPrepareRequest,
    now_ms: u64,
) -> Result<PreparedAuthority, AssetError> {
    let lease = tx.load_lease(&request.lease_id).map_err(store_error)?;
    let lease = lease.ok_or_else(|| {
        AssetError::new(
            AssetErrorCode::LeaseInvalid,
            ErrorPhase::Acquire,
            "lease is revoked or unknown".to_string(),
        )
    })?;
    if lease.security_domain != capability.domain() {
        return Err(AssetError::new(
            AssetErrorCode::Unauthorized,
            ErrorPhase::Acquire,
            "lease belongs to a different security domain".to_string(),
        ));
    }
    if lease.owner != capability.instance_id() {
        return Err(AssetError::new(
            AssetErrorCode::Unauthorized,
            ErrorPhase::Acquire,
            "lease owner does not match the capability instance".to_string(),
        ));
    }
    if lease.asset_id != request.asset_ref.asset_id.as_str() {
        return Err(AssetError::new(
            AssetErrorCode::Unauthorized,
            ErrorPhase::Acquire,
            "lease does not bind the requested asset".to_string(),
        ));
    }
    if lease.expires_at_ms <= now_ms {
        return Err(AssetError::new(
            AssetErrorCode::LeaseInvalid,
            ErrorPhase::Acquire,
            "lease has expired".to_string(),
        ));
    }

    let asset = tx
        .load_live_asset(
            request.asset_ref.asset_id.as_str(),
            capability.domain(),
        )
        .map_err(store_error)?;
    let asset = asset.ok_or_else(|| {
        AssetError::new(
            AssetErrorCode::NotFound,
            ErrorPhase::Acquire,
            "asset is not available in this security domain".to_string(),
        )
    })?;
    if asset.local_state != crate::record::LocalState::Present {
        return Err(AssetError::new(
            AssetErrorCode::NotFound,
            ErrorPhase::Acquire,
            "asset bytes are not present".to_string(),
        ));
    }
    if lease.generation != asset.generation {
        return Err(AssetError::new(
            AssetErrorCode::LeaseInvalid,
            ErrorPhase::Acquire,
            "lease binds a stale generation; it is no longer current".to_string(),
        ));
    }

    // The reference must be the exact current durable identity, never a
    // stale or forged claim.
    let detected_type = MediaType::parse(
        asset
            .detected_media_type
            .as_deref()
            .unwrap_or("application/octet-stream"),
    )
    .map_err(|reason| {
        AssetError::new(
            AssetErrorCode::NotFound,
            ErrorPhase::Acquire,
            format!("durable asset record has a non-canonical media type: {reason}"),
        )
    })?;
    if request.asset_ref.byte_length != asset.byte_length {
        return Err(AssetError::new(
            AssetErrorCode::NotFound,
            ErrorPhase::Acquire,
            "reference does not match the durable asset record".to_string(),
        ));
    }
    if request.asset_ref.media_type != detected_type {
        return Err(AssetError::new(
            AssetErrorCode::NotFound,
            ErrorPhase::Acquire,
            "reference media type does not match the durable asset record".to_string(),
        ));
    }
    if request.expected_media_kind != media_kind_of_type(Some(&detected_type)) {
        return Err(AssetError::new(
            AssetErrorCode::Unauthorized,
            ErrorPhase::Acquire,
            "expected media kind does not match the authoritative detected type".to_string(),
        ));
    }
    if let Some(claimed) = &request.claimed_media_type {
        if claimed != &detected_type {
            return Err(AssetError::new(
                AssetErrorCode::Unauthorized,
                ErrorPhase::Acquire,
                "claimed media type does not match the authoritative detected type".to_string(),
            ));
        }
    }
    if is_active_document(&detected_type) {
        return Err(AssetError::new(
            AssetErrorCode::UnsafeMedia,
            ErrorPhase::Acquire,
            "active document content is not transportable media".to_string(),
        ));
    }

    Ok(PreparedAuthority {
        lease,
        asset,
        detected_type,
    })
}

/// Read the exact recorded bytes through the content-addressed reader and
/// return them only after the on-the-fly BLAKE3 digest matches the durable
/// record. Any length, I/O, or digest failure fails closed with no bytes
/// released.
pub(crate) fn read_and_verify(
    content_root: &Path,
    asset_id: &str,
    byte_length: u64,
    expected_hash: &ContentHash,
) -> Result<Vec<u8>, AssetError> {
    let mut reader = ObjectReader::open(content_root, asset_id, byte_length).map_err(|e| {
        AssetError::new(
            AssetErrorCode::NotFound,
            ErrorPhase::Acquire,
            format!("asset bytes are not present or readable: {e}"),
        )
    })?;
    let mut bytes = Vec::with_capacity(byte_length as usize);
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader.read_bounded(&mut buf).map_err(|e| {
            AssetError::new(
                AssetErrorCode::Internal,
                ErrorPhase::Acquire,
                format!("failed reading asset bytes: {e}"),
            )
        })?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..n]);
    }
    let actual = ContentHash::of_bytes(&bytes);
    if &actual != expected_hash {
        return Err(AssetError::new(
            AssetErrorCode::HashMismatch,
            ErrorPhase::Verify,
            "asset bytes failed digest verification; refusing to release them".to_string(),
        ));
    }
    Ok(bytes)
}

fn store_error(error: crate::store::StoreError) -> AssetError {
    AssetError::new(
        AssetErrorCode::Internal,
        ErrorPhase::Accept,
        format!("asset store failure: {error}"),
    )
}
