//! Channel-side asset-part premise boundary (WP-013B).
//!
//! `org.dolly.channel.send` carries ordered Core `Part` assets: each is an
//! [`AssetPremise`] binding a canonical `asset_id`, the declared
//! `media_type`, and an optional normalized crop (`view`, the shared
//! [`CropRect`] with authoritative materialization semantics — the Channel
//! never duplicates normalized-only crop logic). A premise is an explicit
//! durable reference only: the Channel never reimplements Asset authority,
//! never reads asset bytes as authority, never accepts a raw path or byte
//! buffer as a premise, and never derives a premise from ingress,
//! `runtime_events`, or caller blocks. Every premise is handed, in Action
//! part order, to the single injected [`AssetPreparation`] seam (sole
//! integrator: the Host/Runtime), which proves each asset is available and
//! canonical under the Channel's authority and mints one typed short-lease
//! [`AssetLeaseProof`] per premise. A noncanonical, foreign, unavailable,
//! stale, revoked, over-bound, or unsafely-viewed premised asset refuses the
//! whole send before any durable `Prepared` row or transport effect.
//!
//! Durable records contain only canonical, typed premise/proof metadata.
//! Ephemeral prepared bytes ([`AssetPayload`]) are minted strictly
//! immediately before the first transport effect by the injected adapter and
//! are never persisted.

use serde::{Deserialize, Serialize};

use dolly_schema::{CropError, CropRect, DisplaySize, ExifOrientation, MaterializedBounds};

use crate::error::{ChannelError, ChannelOutcome, codes};

/// One ordered asset premise of a committed send: identity fixed by the
/// frozen Action arguments (part order preserved). Produced ONLY by the
/// committed target-Action boundary; no caller-shaped or reverse-derived
/// authority reaches this type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetPremise {
    /// The part index inside the frozen `arguments.parts` array.
    pub ordinal: u32,
    /// Canonical `AssetId` (`ast_b3_` + 52 base32 chars ending in `a`/`q`).
    pub asset_id: String,
    /// The lowercase, parameter-free canonical media type declared by the
    /// committed Action. The Channel does not treat this as authority: the
    /// injected seam must confirm it against the authoritative Asset record
    /// (detected media type).
    pub media_type: String,
    /// Optional normalized crop; the whole asset when absent. The shared
    /// [`CropRect`] enforces the fixed-point bounds and order invariants.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<CropRect>,
}

/// A closed, fully-typed short-lease proof minted by the injected
/// [`AssetPreparation`] seam. It carries only canonical metadata the Channel
/// may enforce — lease identity/expiry/generation, the authoritative detected
/// media type and byte length, encoded dimensions/orientation (for view
/// materialization against the authoritative record), and the canonical
/// content digest. There is no path, capability, raw caller JSON, or opaque
/// escape: every field has a fixed type and meaning. The Channel persists it
/// with the durable outbound record and hands it to the injected transport
/// seam; it never reads asset bytes itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetLeaseProof {
    /// Integrator-minted short-lease identifier.
    pub lease_id: String,
    /// Durable lease expiry (UTC RFC 3339, the adapter's lease bound).
    pub lease_expires_at: String,
    /// Durable lease generation (monotonic per asset record).
    pub lease_generation: i64,
    /// The authoritative detected media type from the Asset record. It MUST
    /// equal the committed Action's declared `media_type`; a mismatch is a
    /// forged media label and fails the whole send before dispatch.
    pub media_type: String,
    /// The authoritative byte length of the asset, enforced against the
    /// configured outbound media size bound.
    pub byte_length: u64,
    /// Authoritative encoded (pre-transform) width.
    pub encoded_width: u64,
    /// Authoritative encoded (pre-transform) height.
    pub encoded_height: u64,
    /// Authoritative EXIF orientation (`1..=8`); missing means `1`.
    pub orientation: u8,
    /// The canonical content digest of the asset record (integrity premise,
    /// never path or store identity).
    pub content_digest: String,
}

/// The asset part of one authorized send: the frozen premise plus the typed
/// lease proof that this premise is currently prepared under the Channel's
/// authority. This is the ONLY asset metadata the Channel persists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedAsset {
    pub premise: AssetPremise,
    pub lease_proof: AssetLeaseProof,
}

/// Ephemeral, non-durable send payload for one prepared asset. Minted ONLY
/// by the injected adapter immediately before the first transport effect;
/// never persisted, never part of a durable record, and carrying no identity
/// of its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetPayload {
    /// The exact prepared bytes handed to the transport seam.
    pub bytes: Vec<u8>,
}

/// The single injected Asset-authority seam for ordered multimodal sends
/// (sole integrator: the Host/Runtime). It implements Core AssetPart
/// authorization, authoritative detected-media-type, safe-view, crop
/// materialization, and short-lease checks for the exact AssetRef premises of
/// one committed send; the Channel never reimplements any of that authority.
pub trait AssetPreparation {
    /// Prepare the exact ordered asset premises of one committed send and
    /// mint one typed short-lease proof per premise, in premise order. Any
    /// noncanonical, foreign, unavailable, stale, or revoked premise refuses
    /// the whole send (returned [`ChannelError`]) before any durable
    /// `Prepared` row or transport effect.
    fn prepare_assets(
        &mut self,
        premises: &[AssetPremise],
    ) -> Result<Vec<AssetLeaseProof>, ChannelError>;

    /// Mint the ephemeral, non-durable payload of one prepared asset
    /// immediately before the first transport effect. The payload is bounded
    /// by the Channel's configured media size bound and is never persisted.
    fn asset_payload(&mut self, proof: &AssetLeaseProof) -> Result<AssetPayload, ChannelError>;

    /// Re-validate, after queue/blocking work, that every lease behind the
    /// proofs is still live. An invalidated, stale, or revoked lease fails
    /// closed with no transport effect.
    fn revalidate_leases(&mut self, proofs: &[AssetLeaseProof]) -> Result<(), ChannelError>;
}

/// Default fail-closed seam: the accepted v1 text-only profile. Any asset
/// premise is refused with `CHANNEL_UNSUPPORTED_MODALITY` before any durable
/// or transport effect; only an explicitly injected integrator seam may
/// enable asset parts.
#[derive(Debug, Clone, Copy, Default)]
pub struct DenyAssetParts;

impl AssetPreparation for DenyAssetParts {
    fn prepare_assets(
        &mut self,
        premises: &[AssetPremise],
    ) -> Result<Vec<AssetLeaseProof>, ChannelError> {
        let Some(first) = premises.first() else {
            return Ok(Vec::new());
        };
        Err(ChannelError::new(
            codes::UNSUPPORTED_MODALITY,
            false,
            ChannelOutcome::NotApplied,
            format!(
                "asset parts require the WP-013B channel multimodal profile (asset part at ordinal {} is not prepared)",
                first.ordinal
            ),
        ))
    }

    fn asset_payload(&mut self, _proof: &AssetLeaseProof) -> Result<AssetPayload, ChannelError> {
        Err(ChannelError::new(
            codes::UNSUPPORTED_MODALITY,
            false,
            ChannelOutcome::NotApplied,
            "asset payloads require the WP-013B channel multimodal profile",
        ))
    }

    fn revalidate_leases(&mut self, _proofs: &[AssetLeaseProof]) -> Result<(), ChannelError> {
        Ok(())
    }
}

/// Parse one asset part of a frozen send `arguments.parts` entry into a
/// canonical [`AssetPremise`]. Schema validation already ran against the
/// frozen `channel-send` bundle; the Channel additionally enforces the
/// canonical forms so the acceptance boundary is self-contained and fails
/// closed. The crop uses the shared [`CropRect`] constructor (same
/// coordinates, order, and bounds invariants as the accepted reference);
/// only materialization against the authoritative display is performed here,
/// never duplicated normalized-only logic.
pub(crate) fn parse_asset_premise(
    ordinal: u32,
    part: &dolly_canonical_json::CanonicalJsonValue,
) -> Result<AssetPremise, ChannelError> {
    let malformed = |message: &str| {
        ChannelError::new(
            codes::MALFORMED_EVENT,
            false,
            ChannelOutcome::NotApplied,
            format!("asset part at ordinal {ordinal}: {message}"),
        )
    };
    let part_obj = match part {
        dolly_canonical_json::CanonicalJsonValue::Object(object) => object,
        _ => return Err(malformed("must be an object")),
    };
    let asset_id = match part_obj.get("asset_id") {
        Some(dolly_canonical_json::CanonicalJsonValue::String(id)) => id.clone(),
        _ => return Err(malformed("missing asset_id")),
    };
    if !is_canonical_asset_id(&asset_id) {
        return Err(malformed("asset_id is not a canonical AssetId"));
    }
    let media_type = match part_obj.get("media_type") {
        Some(dolly_canonical_json::CanonicalJsonValue::String(media_type)) => media_type.clone(),
        _ => return Err(malformed("missing media_type")),
    };
    if !is_canonical_media_type(&media_type) {
        return Err(malformed("media_type is not a canonical lowercase media type"));
    }
    let view = match part_obj.get("view") {
        None => None,
        Some(dolly_canonical_json::CanonicalJsonValue::Object(view)) => {
            let coordinate = |name: &str| -> Result<u64, ChannelError> {
                let raw = match view.get(name) {
                    Some(dolly_canonical_json::CanonicalJsonValue::Number(number)) => {
                        number.as_f64()
                    }
                    _ => return Err(malformed(&format!("crop view missing {name}"))),
                };
                if !raw.is_finite() || raw < 0.0 || raw.fract() != 0.0 || raw > 1_000_000.0 {
                    return Err(malformed(&format!(
                        "{name} is not a non-negative canonical integer"
                    )));
                }
                Ok(raw as u64)
            };
            let rect = CropRect::new(
                coordinate("x0")?,
                coordinate("y0")?,
                coordinate("x1")?,
                coordinate("y1")?,
            )
            .map_err(|error: CropError| malformed(&error.to_string()))?;
            Some(rect)
        }
        Some(_) => return Err(malformed("crop view must be an object")),
    };
    Ok(AssetPremise {
        ordinal,
        asset_id,
        media_type,
        view,
    })
}

/// Verify one injected lease proof against its frozen premise and the
/// configured outbound media bounds. A mismatched authoritative detected
/// media type (forged media label), an empty lease identity, an over-bounds
/// byte length, or a noncanonical orientation/dimension/digest fails the
/// whole send before any durable or transport effect.
pub(crate) fn validate_prepared_asset(
    premise: &AssetPremise,
    proof: &AssetLeaseProof,
    max_asset_bytes: usize,
) -> Result<(), String> {
    if premise.media_type != proof.media_type {
        return Err(format!(
            "the authoritative detected media type is {} but the committed Action declares {}",
            proof.media_type, premise.media_type
        ));
    }
    if proof.lease_id.is_empty() || proof.lease_expires_at.is_empty() {
        return Err("the prepared lease has no identity or expiry".to_string());
    }
    if proof.byte_length == 0 || proof.byte_length > max_asset_bytes as u64 {
        return Err(format!(
            "the authoritative byte length {} is outside the configured maximum {} bytes",
            proof.byte_length, max_asset_bytes
        ));
    }
    ExifOrientation::new(proof.orientation)
        .map_err(|error| format!("the authoritative orientation is invalid: {error}"))?;
    DisplaySize::new(proof.encoded_width, proof.encoded_height)
        .map_err(|error| format!("the authoritative encoded dimensions are invalid: {error}"))?;
    if proof.content_digest.is_empty() {
        return Err("the prepared asset has no canonical content digest".to_string());
    }
    Ok(())
}

/// Materialize the premised normalized crop onto the authoritative prepared
/// display (derived from the proof's encoded dimensions and EXIF
/// orientation) using the shared crop module — never duplicated Channel
/// logic. An unsafe or out-of-bounds view fails the whole send. `None` when
/// the premise has no crop (the whole asset).
pub(crate) fn materialized_view(
    premise: &AssetPremise,
    proof: &AssetLeaseProof,
) -> Result<Option<MaterializedBounds>, String> {
    let Some(view) = &premise.view else {
        return Ok(None);
    };
    let orientation = ExifOrientation::new(proof.orientation)
        .map_err(|error| format!("the authoritative orientation is invalid: {error}"))?;
    let display = orientation
        .display_size(proof.encoded_width, proof.encoded_height)
        .map_err(|error| format!("the authoritative display is invalid: {error}"))?;
    view.materialize(&display)
        .map(Some)
        .map_err(|error| format!("the premised crop is unsafe for the authoritative display: {error}"))
}

/// Canonical `AssetId` check: `ast_b3_` followed by 52 characters from the
/// lowercase base32 alphabet `a-z2-7`, the last of which is `a` or `q`.
pub(crate) fn is_canonical_asset_id(value: &str) -> bool {
    let Some(encoded) = value.strip_prefix("ast_b3_") else {
        return false;
    };
    if encoded.len() != 52 {
        return false;
    }
    let bytes = encoded.as_bytes();
    if bytes[51] != b'a' && bytes[51] != b'q' {
        return false;
    }
    bytes.iter().all(|byte| is_base32_char(*byte))
}

fn is_base32_char(byte: u8) -> bool {
    matches!(byte, b'a'..=b'z' | b'2'..=b'7')
}

/// Canonical lowercase MIME media type check matching the `MimeType` schema
/// pattern `^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$`.
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
    fn canonical_asset_id_forms() {
        assert!(is_canonical_asset_id(
            "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
        // A valid digest of `b` characters ending in `q`.
        let b_valid = format!("ast_b3_{}q", "b".repeat(51));
        assert!(is_canonical_asset_id(&b_valid));
        // A valid 52-char digest ending in `q`.
        let mut id = "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();
        id.replace_range(58..59, "q");
        assert!(is_canonical_asset_id(&id));
        // Wrong prefix, length, alphabet, and final character.
        assert!(!is_canonical_asset_id("ast_b4_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(!is_canonical_asset_id("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(!is_canonical_asset_id(
            "ast_b3_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        ));
        let mut bad = "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();
        bad.replace_range(58..59, "b");
        assert!(!is_canonical_asset_id(&bad));
    }

    #[test]
    fn canonical_media_type_forms() {
        assert!(is_canonical_media_type("image/png"));
        assert!(is_canonical_media_type("application/vnd.example+json"));
        assert!(is_canonical_media_type("text/plain"));
        assert!(!is_canonical_media_type("Image/PNG"));
        assert!(!is_canonical_media_type("image/png;charset=utf-8"));
        assert!(!is_canonical_media_type("image"));
        assert!(!is_canonical_media_type(" image/png"));
    }

    #[test]
    fn shared_crop_rect_validates_the_full_premise_invariants() {
        // The clos shared CropRect enforces coordinates and order; an empty
        // or inverted rectangle is rejected at construction.
        assert!(CropRect::new(100_000, 200_000, 600_000, 600_000).is_ok());
        assert!(CropRect::new(600_000, 600_000, 100_000, 100_000).is_err());
        assert!(CropRect::new(500_000, 0, 500_000, 10).is_err());
        assert!(CropRect::new(1_000_000, 0, 1_000_000, 1).is_err());
        assert!(CropRect::new(0, 0, 0, 10).is_err());
    }

    #[test]
    fn typed_proof_validation_and_materialization() {
        let premise = AssetPremise {
            ordinal: 1,
            asset_id: "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            media_type: "image/png".to_string(),
            view: Some(CropRect::new(100_000, 200_000, 600_000, 600_000).unwrap()),
        };
        let mut proof = AssetLeaseProof {
            lease_id: "lease-1".to_string(),
            lease_expires_at: "2026-08-29T00:00:00.000000Z".to_string(),
            lease_generation: 1,
            media_type: "image/png".to_string(),
            byte_length: 1000,
            encoded_width: 1000,
            encoded_height: 500,
            orientation: 1,
            content_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                .to_string(),
        };
        assert!(validate_prepared_asset(&premise, &proof, 4096).is_ok());
        // Materialization against the authoritative display (no Channel crop
        // logic) produces the exact clamped pixel bounds.
        let bounds = materialized_view(&premise, &proof).unwrap().unwrap();
        assert_eq!(
            (bounds.left(), bounds.top(), bounds.right(), bounds.bottom()),
            (100, 100, 600, 300)
        );
        // A forged detected media type fails closed.
        proof.media_type = "image/jpeg".to_string();
        assert!(validate_prepared_asset(&premise, &proof, 4096).is_err());
        proof.media_type = "image/png".to_string();
        // Over-bound byte length fails closed.
        assert!(validate_prepared_asset(&premise, &proof, 100).is_err());
        // A forged orientation fails closed.
        proof.byte_length = 1000;
        proof.orientation = 9;
        assert!(validate_prepared_asset(&premise, &proof, 4096).is_err());
        assert!(materialized_view(&premise, &proof).is_err());
        // An axis-swapped orientation materializes onto the transposed frame.
        proof.orientation = 6;
        assert!(validate_prepared_asset(&premise, &proof, 4096).is_ok());
        let swapped = materialized_view(&premise, &proof).unwrap().unwrap();
        assert_eq!(
            (swapped.left(), swapped.top(), swapped.right(), swapped.bottom()),
            (50, 200, 300, 600)
        );

        // The whole asset (no crop) has no materialized bounds.
        let mut whole = premise.clone();
        whole.view = None;
        assert!(materialized_view(&whole, &proof).unwrap().is_none());
    }

    #[test]
    fn deny_seam_refuses_any_asset_premise_and_payload() {
        let mut seam = DenyAssetParts;
        let premise = AssetPremise {
            ordinal: 1,
            asset_id: "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            media_type: "image/png".to_string(),
            view: None,
        };
        let error = seam.prepare_assets(&[premise]).expect_err("asset part refused");
        assert_eq!(error.code, codes::UNSUPPORTED_MODALITY);
        assert!(!error.retryable);
        assert_eq!(error.outcome, ChannelOutcome::NotApplied);
        assert!(seam.prepare_assets(&[]).unwrap().is_empty());
        let proof = AssetLeaseProof {
            lease_id: "x".to_string(),
            lease_expires_at: "x".to_string(),
            lease_generation: 0,
            media_type: "image/png".to_string(),
            byte_length: 1,
            encoded_width: 1,
            encoded_height: 1,
            orientation: 1,
            content_digest: "d".to_string(),
        };
        assert!(seam.asset_payload(&proof).is_err());
        assert!(seam.revalidate_leases(&[]).is_ok());
    }
}
