//! Channel-side asset-part premise boundary (WP-013B).
//!
//! `org.dolly.channel.send` carries ordered Core `Part` assets: each is an
//! [`AssetPremise`] binding a canonical `asset_id`, the declared
//! `media_type`, and an optional normalized crop (`view`). A premise is an
//! explicit durable reference only: the Channel never reimplements Asset
//! authority, never reads asset bytes, never accepts a raw path or byte
//! buffer as authority, and never derives a premise from ingress,
//! `runtime_events`, or caller blocks. Every premise is handed, in Action
//! part order, to the single injected [`AssetPreparation`] seam (sole
//! integrator: the Host/Runtime), which proves the asset is available and
//! canonical under the Channel's authority and mints one short-lease
//! [`AssetLeaseProof`] per premise for the transport seam. A noncanonical,
//! foreign, unavailable, stale, or revoked premised asset refuses the whole
//! send before any durable `Prepared` row or transport effect.

use serde::{Deserialize, Serialize};

use crate::error::{ChannelError, ChannelOutcome, codes};

/// The normalized fixed-point crop rectangle of one asset part, in upright
/// display space. Integers in `0..=1_000_000` with `x0 < x1` and `y0 < y1`;
/// the JSON Schema validates the numeric range and this type adds the
/// cross-coordinate invariants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CropRect {
    pub x0: u64,
    pub y0: u64,
    pub x1: u64,
    pub y1: u64,
}

impl CropRect {
    /// The normalized fixed-point coordinate space shared by the Core
    /// `CropRect` schema: `x0`/`y0` in `0..=999_999` and `x1`/`y1` in
    /// `1..=1_000_000`.
    pub const MAX: u64 = 1_000_000;

    /// Fail closed on non-canonical or empty crop rectangles: the top-left
    /// corner must lie strictly inside the space (`x0 < MAX`, `y0 < MAX`),
    /// the bottom-right corner must be non-zero and at most `MAX`, and the
    /// rectangle must select at least one pixel (`x0 < x1`, `y0 < y1`).
    pub fn validate(&self) -> Result<(), String> {
        if self.x0 >= Self::MAX || self.y0 >= Self::MAX {
            return Err("crop top-left coordinate is outside 0..=999999".to_string());
        }
        if self.x1 == 0 || self.x1 > Self::MAX || self.y1 == 0 || self.y1 > Self::MAX {
            return Err("crop bottom-right coordinate is outside 1..=1000000".to_string());
        }
        if self.x0 >= self.x1 || self.y0 >= self.y1 {
            return Err("crop rectangle must be non-empty (x0 < x1 and y0 < y1)".to_string());
        }
        Ok(())
    }
}

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
    /// The lowercase, parameter-free canonical media type. The Channel does
    /// not treat this as authority: the injected seam must confirm it
    /// against the authoritative Asset record (detected media type).
    pub media_type: String,
    /// Optional normalized crop; the whole asset when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<CropRect>,
}

/// A typed short-lease proof minted by the injected [`AssetPreparation`]
/// seam. It carries only the canonical metadata the Channel may enforce —
/// the authoritative detected media type and byte length for the configured
/// outbound media bounds — plus an opaque adapter-owned proof value. It
/// never carries a raw path, store identity, or caller authority. The
/// Channel persists it with the durable outbound record and hands it to the
/// injected transport seam, and never reads asset bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetLeaseProof {
    /// Integrator-minted short-lease identifier.
    pub lease_id: String,
    /// The authoritative detected media type from the Asset record. It MUST
    /// equal the committed Action's declared `media_type`; a mismatch is a
    /// forged media label and fails the whole send before dispatch.
    pub media_type: String,
    /// The authoritative byte length of the asset, enforced against the
    /// configured outbound media size bound.
    pub byte_length: u64,
    /// Opaque adapter-owned proof value (for example an access/read handle
    /// for the transport seam). The Channel never interprets its fields.
    pub value: serde_json::Value,
}

/// Verify one injected lease proof against its frozen premise and the
/// configured outbound media bounds. A mismatched authoritative detected
/// media type (forged media label), an empty lease identifier, or an
/// over-bounds byte length fails the whole send before any durable or
/// transport effect.
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
    if proof.lease_id.is_empty() {
        return Err("the prepared lease has no identifier".to_string());
    }
    if proof.byte_length > max_asset_bytes as u64 {
        return Err(format!(
            "the authoritative byte length {} exceeds the configured maximum {} bytes",
            proof.byte_length, max_asset_bytes
        ));
    }
    Ok(())
}

/// The asset part of one authorized send: the frozen premise plus the lease
/// proof that this premise is currently prepared under the Channel's
/// authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedAsset {
    pub premise: AssetPremise,
    pub lease_proof: AssetLeaseProof,
}

/// The single injected Asset-authority seam for ordered multimodal sends
/// (sole integrator: the Host/Runtime). It implements Core AssetPart
/// authorization, authoritative detected-media-type, safe-view, crop, and
/// short-lease checks for the exact AssetRef premises of one committed send;
/// the Channel never reimplements any of that authority.
pub trait AssetPreparation {
    /// Prepare the exact ordered asset premises of one committed send and
    /// mint one short-lease proof per premise, in premise order. Any
    /// noncanonical, foreign, unavailable, stale, or revoked premise refuses
    /// the whole send (returned [`ChannelError`]) before any durable
    /// `Prepared` row or transport effect.
    fn prepare_assets(
        &mut self,
        premises: &[AssetPremise],
    ) -> Result<Vec<AssetLeaseProof>, ChannelError>;

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

    fn revalidate_leases(&mut self, _proofs: &[AssetLeaseProof]) -> Result<(), ChannelError> {
        Ok(())
    }
}

/// Parse one asset part of a frozen send `arguments.parts` entry into a
/// canonical [`AssetPremise`]. Schema validation already ran against the
/// frozen `channel-send` bundle; the Channel additionally enforces the
/// canonical forms and the crop invariants the JSON Schema cannot express,
/// so the acceptance boundary is self-contained and fails closed.
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
            let rect = CropRect {
                x0: coordinate("x0")?,
                y0: coordinate("y0")?,
                x1: coordinate("x1")?,
                y1: coordinate("y1")?,
            };
            rect.validate()
                .map_err(|message| malformed(&format!("crop view is invalid: {message}")))?;
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
    fn crop_rect_bounds_and_emptiness() {
        let valid = CropRect { x0: 0, y0: 0, x1: 1_000_000, y1: 1_000_000 };
        assert!(valid.validate().is_ok());
        let empty = CropRect { x0: 500_000, y0: 0, x1: 500_000, y1: 10 };
        assert!(empty.validate().is_err());
        let swapped = CropRect { x0: 600_000, y0: 0, x1: 100_000, y1: 10 };
        assert!(swapped.validate().is_err());
        let out_of_range = CropRect { x0: 1_000_000, y0: 0, x1: 1_000_000, y1: 1 };
        assert!(out_of_range.validate().is_err());
        let zero_corner = CropRect { x0: 0, y0: 0, x1: 0, y1: 10 };
        assert!(zero_corner.validate().is_err());
    }

    #[test]
    fn deny_seam_refuses_any_asset_premise() {
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
        assert!(seam.revalidate_leases(&[]).is_ok());
    }
}
