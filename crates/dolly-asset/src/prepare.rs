//! WP-013B Asset-side media preparation seam.
//!
//! `AssetService::prepare_media` turns a committed authoritative `AssetId`
//! into the canonical `AssetRef` minted from the durable record, plus a
//! bounded, digest-verified copy of the immutable bytes, guarded by the
//! caller's exact lease. The caller supplies only the committed `AssetId`,
//! kind/type claims, and lease proof; the service resolves the authoritative
//! row itself and mints every reference field. Acceptance is fail-closed:
//! only an asset whose durable lifecycle row is live and present in the
//! caller's security domain, whose current generation and content-identity
//! exactly match the committed `AssetId`, and whose caller-held lease is
//! unexpired and bound to this capability's instance, domain, asset, and
//! generation can be prepared. Pending, failed, deleted, stale, revoked,
//! foreign, forged, and non-canonical identities never release bytes.
//!
//! The caller's media-kind and media-type claims are checks, never
//! authority: the result carries only the detected media type recorded at
//! import, and active document content (PDF, HTML, SVG) is refused rather
//! than relabeled. Bytes are read through the content-addressed
//! `ObjectReader` (no caller-chosen path or network), verified against the
//! recorded BLAKE3 digest (so `AssetId = BLAKE3(content)` is re-proven),
//! and the full lease/asset authority is revalidated after the blocking
//! read and immediately before the typed result is released.

use crate::content::ObjectReader;
use crate::error::{AssetError, AssetErrorCode, ErrorPhase};
use crate::identity::{AssetId, AssetRef, ContentHash, MediaType};
use crate::record::{AssetLease, AssetRecord, MediaKind};
use crate::service::AssetCapability;
use crate::store::{AssetStore, StoreTransaction};
use std::path::Path;

/// One media preparation request (the WP-013B Channel seam input).
///
/// Only the committed content-addressed `asset_id` is trusted input from the
/// caller, and it is re-proven against the durable record's content digest
/// before any bytes are read. `lease_id` is the caller-held short Asset
/// lease that must remain current through the whole preparation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaPrepareRequest {
    /// The committed `AssetId` to prepare (from an AssetPart). Verified to
    /// equal `BLAKE3(content)` through the durable record inside the store;
    /// a forged or stale `AssetId` is refused before any byte read.
    pub asset_id: AssetId,
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
/// `asset_ref` is the canonical reference minted by the service from the
/// durable row: every field (media type, byte length, orientation, and image
/// dimensions) is the inspected/stored value, and no caller-supplied
/// metadata is echoed. `bytes` is an exact copy of the immutable asset
/// bytes, capped by the current decoded-byte configuration, with `digest`
/// verified against that copy before release. No path, URL, capability, or
/// other ambient authority appears in the result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedMedia {
    /// The canonical, fully authoritative reference minted from the durable
    /// row.
    pub asset_ref: AssetRef,
    /// The media kind derived from the detected type, never caller-shaped.
    pub media_kind: MediaKind,
    /// The exact current lifecycle generation that held the lease.
    pub generation: u64,
    /// The canonical BLAKE3 digest verified against `bytes` (so the prepared
    /// identity is exactly `AssetId = BLAKE3(bytes)`).
    pub digest: ContentHash,
    /// The lease that guarded the read; still live and current on return.
    pub lease_id: String,
    /// When that lease expires, in milliseconds since the Unix epoch; the
    /// authority proof a Channel adapter carries for its send window.
    pub lease_expires_at_ms: u64,
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
    /// The canonical reference minted from the durable row.
    pub canonical_ref: AssetRef,
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
/// forged identity or content digest, non-canonical durable record, forged
/// kind or media type, and active document content.
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
    if lease.asset_id != request.asset_id.as_str() {
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
        .load_live_asset(request.asset_id.as_str(), capability.domain())
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

    // The committed identity must be exactly the content identity. A row
    // whose recorded digest does not derive the requested `AssetId` is a
    // forged or non-canonical identity and is refused before any byte read.
    if AssetId::from_digest(asset.content_hash.digest) != request.asset_id {
        return Err(AssetError::new(
            AssetErrorCode::InvalidRequest,
            ErrorPhase::Validate,
            "asset identity does not match its recorded content digest".to_string(),
        ));
    }

    // Mint the full canonical reference from the durable row. Every field is
    // the inspected/stored value; nothing caller-supplied is echoed. A row
    // that cannot mint a canonical reference is refused.
    let canonical_ref = asset.asset_ref().ok_or_else(|| {
        AssetError::new(
            AssetErrorCode::NotFound,
            ErrorPhase::Acquire,
            "durable asset record cannot mint a canonical reference".to_string(),
        )
    })?;

    // The authoritative detected type is the recorded value; caller claims
    // are only checked against it.
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
        canonical_ref,
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


/// Re-prove the authoritative content metadata against the bytes the
/// existing bounded reader can check, and apply the current configuration
/// bounds at effect time. For a row that recorded a supported MIME type, the
/// content head MUST sniff to exactly that type (malformed content claiming a
/// supported MIME is refused), the inspected dimensions MUST match the stored
/// values, and image pixel counts MUST stay inside the configured
/// `max_image_pixels` bound. Rows recorded as unrecognized octet streams have
/// no provable signature and pass through.
pub(crate) fn verify_content_consistency(
    bytes: &[u8],
    asset: &AssetRecord,
    max_pixels: u64,
) -> Result<(), AssetError> {
    let Some(recorded) = asset.detected_media_type.as_deref() else {
        // Unrecognized content: nothing the bounded reader can prove.
        return Ok(());
    };
    let head = &bytes[..bytes.len().min(crate::media::SNIFF_HEAD_BYTES)];
    let probe = crate::media::probe_media_head(head, max_pixels).map_err(|e| {
        AssetError::new(
            AssetErrorCode::UnsafeMedia,
            ErrorPhase::Verify,
            format!("content fails bounded metadata bounds: {}", e.message),
        )
    })?;
    let detected = probe.detected.ok_or_else(|| {
        AssetError::new(
            AssetErrorCode::MediaTypeMismatch,
            ErrorPhase::Verify,
            "content does not match its recorded supported media type".to_string(),
        )
    })?;
    if detected.as_str() != recorded {
        return Err(AssetError::new(
            AssetErrorCode::MediaTypeMismatch,
            ErrorPhase::Verify,
            format!("content sniffs as {detected} but the durable record says {recorded}"),
        ));
    }
    if let Some(recorded_orientation) = asset.orientation {
        if probe.orientation != recorded_orientation {
            return Err(AssetError::new(
                AssetErrorCode::UnsafeMedia,
                ErrorPhase::Verify,
                "content orientation does not match the durable record".to_string(),
            ));
        }
    }
    if let Some(recorded_width) = asset.encoded_width {
        if probe.width != Some(recorded_width) {
            return Err(AssetError::new(
                AssetErrorCode::UnsafeMedia,
                ErrorPhase::Verify,
                "content width does not match the durable record".to_string(),
            ));
        }
    }
    if let Some(recorded_height) = asset.encoded_height {
        if probe.height != Some(recorded_height) {
            return Err(AssetError::new(
                AssetErrorCode::UnsafeMedia,
                ErrorPhase::Verify,
                "content height does not match the durable record".to_string(),
            ));
        }
    }
    Ok(())
}
fn store_error(error: crate::store::StoreError) -> AssetError {
    AssetError::new(
        AssetErrorCode::Internal,
        ErrorPhase::Accept,
        format!("asset store failure: {error}"),
    )
}
