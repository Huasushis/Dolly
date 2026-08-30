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

use std::fmt;

use serde::{Deserialize, Serialize};

use dolly_schema::{CropError, CropRect, DisplaySize, MaterializedBounds};

use crate::error::{ChannelError, ChannelOutcome, codes};

const BASE32_ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// Canonical content-addressed Asset identity. Its wire form is identical to
/// Asset's `AssetId`: `ast_b3_` followed by 52 unpadded lowercase RFC 4648
/// base32 characters.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AssetId(String);

impl AssetId {
    pub fn parse(value: &str) -> Result<Self, String> {
        if !is_canonical_asset_id(value) {
            return Err("AssetId string does not match the canonical pattern".to_string());
        }
        Ok(Self(value.to_string()))
    }

    pub fn from_digest(digest: [u8; 32]) -> Self {
        let mut encoded = String::with_capacity(59);
        encoded.push_str("ast_b3_");
        encode_base32(&digest, &mut encoded);
        Self(encoded)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl From<&AssetId> for [u8; 32] {
    fn from(asset_id: &AssetId) -> Self {
        decode_base32_into(&asset_id.0[7..]).expect("validated AssetId decodes")
    }
}

impl fmt::Display for AssetId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for AssetId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for AssetId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

/// Canonical lowercase media type, matching Asset's `MediaType` wire form.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MediaType(String);

impl MediaType {
    pub fn parse(value: &str) -> Result<Self, String> {
        if is_canonical_media_type(value) {
            Ok(Self(value.to_string()))
        } else {
            Err("invalid media type".to_string())
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for MediaType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for MediaType {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for MediaType {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

/// Provider-neutral media kind. The variants and wire names exactly match
/// Asset's closed `MediaKind`.
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
            Self::Image => "image",
            Self::Audio => "audio",
            Self::Video => "video",
            Self::File => "file",
        }
    }
}

/// BLAKE3-256 content digest with Asset's exact typed representation and wire
/// encoding: `{"algorithm":"blake3-256","digest":"<64 lowercase hex>"}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ContentHash {
    pub algorithm: &'static str,
    pub digest: [u8; 32],
}

impl ContentHash {
    pub const ALGORITHM: &'static str = "blake3-256";

    pub fn from_digest(digest: [u8; 32]) -> Self {
        Self {
            algorithm: Self::ALGORITHM,
            digest,
        }
    }

    pub fn digest_hex(&self) -> String {
        encode_hex(&self.digest)
    }
}

impl Serialize for ContentHash {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("ContentHash", 2)?;
        state.serialize_field("algorithm", Self::ALGORITHM)?;
        state.serialize_field("digest", &self.digest_hex())?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for ContentHash {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            algorithm: String,
            digest: String,
        }

        let wire = Wire::deserialize(deserializer)?;
        if wire.algorithm != Self::ALGORITHM {
            return Err(serde::de::Error::custom("unsupported hash algorithm"));
        }
        let digest = decode_hex(&wire.digest).map_err(serde::de::Error::custom)?;
        Ok(Self::from_digest(digest))
    }
}

/// Canonical fully authoritative Asset reference. Every field and optional
/// geometry value mirrors Asset's accepted `AssetRef`; no caller metadata is
/// substituted and no absent geometry is fabricated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AssetRef {
    pub asset_id: AssetId,
    pub media_type: MediaType,
    pub byte_length: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoded_width: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoded_height: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_width: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_height: Option<u64>,
}

impl AssetRef {
    pub const MAX_WIRE_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

    pub fn validate(&self) -> Result<(), String> {
        if self.byte_length > Self::MAX_WIRE_SAFE_INTEGER {
            return Err("byte_length exceeds the canonical wire integer range".to_string());
        }
        if self
            .orientation
            .is_some_and(|value| !(1..=8).contains(&value))
        {
            return Err("orientation must be 1..=8 when present".to_string());
        }
        for (name, value) in [
            ("encoded_width", self.encoded_width),
            ("encoded_height", self.encoded_height),
            ("display_width", self.display_width),
            ("display_height", self.display_height),
        ] {
            if value.is_some_and(|value| value == 0 || value > Self::MAX_WIRE_SAFE_INTEGER) {
                return Err(format!("{name} is outside the canonical wire range"));
            }
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for AssetRef {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            asset_id: AssetId,
            media_type: MediaType,
            byte_length: u64,
            orientation: Option<u8>,
            encoded_width: Option<u64>,
            encoded_height: Option<u64>,
            display_width: Option<u64>,
            display_height: Option<u64>,
        }

        let wire = Wire::deserialize(deserializer)?;
        let asset_ref = Self {
            asset_id: wire.asset_id,
            media_type: wire.media_type,
            byte_length: wire.byte_length,
            orientation: wire.orientation,
            encoded_width: wire.encoded_width,
            encoded_height: wire.encoded_height,
            display_width: wire.display_width,
            display_height: wire.display_height,
        };
        asset_ref.validate().map_err(serde::de::Error::custom)?;
        Ok(asset_ref)
    }
}
/// One ordered committed Asset premise. The request contains only the exact
/// `AssetId`, declared media type, and optional shared crop; all authoritative
/// metadata comes back from the injected Asset preparation seam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetPremise {
    pub ordinal: u32,
    pub asset_id: AssetId,
    pub media_type: MediaType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<CropRect>,
}

/// Durable proof copied field-for-field from Asset `PreparedMedia`, excluding
/// only its ephemeral bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetLeaseProof {
    pub asset_ref: AssetRef,
    pub media_kind: MediaKind,
    pub generation: u64,
    pub digest: ContentHash,
    pub lease_id: String,
    pub lease_expiry_unix_ms: u64,
}

/// Durable asset send metadata. Before preparation it contains only the
/// committed premise; after preparation the exact lease proof is present.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboundAsset {
    pub premise: AssetPremise,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_proof: Option<AssetLeaseProof>,
}

/// Ephemeral field-for-field mirror of Asset `PreparedMedia`. The Runtime
/// adapter constructs this value directly from Asset's result; Channel
/// validates its exact identity, metadata, lease, digest, byte length, and
/// configured bound before dispatch. It is never serializable or durable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetPayload {
    pub asset_ref: AssetRef,
    pub media_kind: MediaKind,
    pub generation: u64,
    pub digest: ContentHash,
    pub lease_id: String,
    pub lease_expiry_unix_ms: u64,
    pub bytes: Vec<u8>,
}

impl AssetPayload {
    pub fn lease_proof(&self) -> AssetLeaseProof {
        AssetLeaseProof {
            asset_ref: self.asset_ref.clone(),
            media_kind: self.media_kind,
            generation: self.generation,
            digest: self.digest,
            lease_id: self.lease_id.clone(),
            lease_expiry_unix_ms: self.lease_expiry_unix_ms,
        }
    }
}

/// The single injected Asset preparation seam. Each result is the exact
/// bounded `PreparedMedia` payload for the premise at the same index. There
/// is no later Asset read or lease service call in the dispatch path.
pub trait AssetPreparation {
    fn prepare_assets(
        &mut self,
        premises: &[AssetPremise],
    ) -> Result<Vec<AssetPayload>, ChannelError>;
}

/// Default fail-closed seam for the accepted text-only profile.
#[derive(Debug, Clone, Copy, Default)]
pub struct DenyAssetParts;

impl AssetPreparation for DenyAssetParts {
    fn prepare_assets(
        &mut self,
        premises: &[AssetPremise],
    ) -> Result<Vec<AssetPayload>, ChannelError> {
        let Some(first) = premises.first() else {
            return Ok(Vec::new());
        };
        Err(ChannelError::new(
            codes::UNSUPPORTED_MODALITY,
            false,
            ChannelOutcome::NotApplied,
            format!(
                "asset parts require the Channel multimodal profile (asset part at ordinal {} is not prepared)",
                first.ordinal
            ),
        ))
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
        Some(dolly_canonical_json::CanonicalJsonValue::String(id)) => {
            AssetId::parse(id).map_err(|_| malformed("asset_id is not a canonical AssetId"))?
        }
        _ => return Err(malformed("missing asset_id")),
    };
    let media_type = match part_obj.get("media_type") {
        Some(dolly_canonical_json::CanonicalJsonValue::String(media_type)) => {
            MediaType::parse(media_type)
                .map_err(|_| malformed("media_type is not a canonical lowercase media type"))?
        }
        _ => return Err(malformed("missing media_type")),
    };
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

/// Validate the exact field-for-field Asset preparation result before the
/// dispatch claim. The payload identity, kind, authoritative reference,
/// BLAKE3 digest, byte length, and configured byte bound must all agree with
/// the committed premise. Geometry remains optional unless a crop is present.
pub(crate) fn validate_asset_payload(
    premise: &AssetPremise,
    payload: &AssetPayload,
    max_asset_bytes: usize,
) -> Result<(), String> {
    let proof = payload.lease_proof();
    validate_prepared_asset(premise, &proof, max_asset_bytes)?;
    if payload.bytes.len() as u64 != payload.asset_ref.byte_length {
        return Err(format!(
            "prepared byte length {} does not match the authoritative byte length {}",
            payload.bytes.len(),
            payload.asset_ref.byte_length
        ));
    }
    Ok(())
}

/// Validate the durable proof copied from one Asset preparation result.
pub(crate) fn validate_prepared_asset(
    premise: &AssetPremise,
    proof: &AssetLeaseProof,
    max_asset_bytes: usize,
) -> Result<(), String> {
    proof.asset_ref.validate()?;
    if premise.asset_id != proof.asset_ref.asset_id {
        return Err(format!(
            "the authoritative AssetId {} does not match the committed AssetId {}",
            proof.asset_ref.asset_id, premise.asset_id
        ));
    }
    if premise.media_type != proof.asset_ref.media_type {
        return Err(format!(
            "the authoritative detected media type is {} but the committed Action declares {}",
            proof.asset_ref.media_type, premise.media_type
        ));
    }
    let expected_kind = media_kind_of_type(&proof.asset_ref.media_type);
    if proof.media_kind != expected_kind {
        return Err(format!(
            "the prepared media kind {} does not match authoritative type {}",
            proof.media_kind.as_str(),
            proof.asset_ref.media_type
        ));
    }
    if proof.lease_id.is_empty() || proof.lease_expiry_unix_ms == 0 {
        return Err("the prepared lease has no identity or numeric expiry".to_string());
    }
    if proof.generation > AssetRef::MAX_WIRE_SAFE_INTEGER
        || proof.lease_expiry_unix_ms > AssetRef::MAX_WIRE_SAFE_INTEGER
    {
        return Err(
            "the prepared generation or lease expiry exceeds the canonical wire integer range"
                .to_string(),
        );
    }
    if proof.asset_ref.byte_length > max_asset_bytes as u64 {
        return Err(format!(
            "the authoritative byte length {} exceeds the configured maximum {} bytes",
            proof.asset_ref.byte_length, max_asset_bytes
        ));
    }
    if proof.digest.algorithm != ContentHash::ALGORITHM {
        return Err("the prepared digest is not BLAKE3-256".to_string());
    }
    if AssetId::from_digest(proof.digest.digest) != proof.asset_ref.asset_id {
        return Err("the prepared BLAKE3 digest does not match the canonical AssetId".to_string());
    }
    materialized_view(premise, proof)?;
    Ok(())
}

/// Non-blocking local revalidation after the durable dispatch claim. This
/// consults no Asset service: it only rechecks the already-held proof,
/// configured bound, payload identity/length, crop, and numeric lease expiry.
pub(crate) fn validate_asset_payload_for_send(
    premise: &AssetPremise,
    payload: &AssetPayload,
    max_asset_bytes: usize,
    now_ms: u64,
) -> Result<(), String> {
    validate_asset_payload(premise, payload, max_asset_bytes)?;
    if payload.lease_expiry_unix_ms <= now_ms {
        return Err("the prepared Asset lease expired before transport send".to_string());
    }
    Ok(())
}

/// Materialize an optional committed crop against the authoritative display
/// dimensions. Geometry is required only for a crop; absent geometry is valid
/// for whole-asset sends and is never replaced with fake values.
pub(crate) fn materialized_view(
    premise: &AssetPremise,
    proof: &AssetLeaseProof,
) -> Result<Option<MaterializedBounds>, String> {
    let Some(view) = &premise.view else {
        return Ok(None);
    };
    let width = proof
        .asset_ref
        .display_width
        .ok_or_else(|| "a crop requires authoritative display_width".to_string())?;
    let height = proof
        .asset_ref
        .display_height
        .ok_or_else(|| "a crop requires authoritative display_height".to_string())?;
    let display = DisplaySize::new(width, height)
        .map_err(|error| format!("the authoritative display is invalid: {error}"))?;
    view.materialize(&display).map(Some).map_err(|error| {
        format!("the premised crop is unsafe for the authoritative display: {error}")
    })
}

pub(crate) fn media_kind_of_type(media_type: &MediaType) -> MediaKind {
    if media_type.as_str().starts_with("image/") {
        MediaKind::Image
    } else if media_type.as_str().starts_with("audio/") {
        MediaKind::Audio
    } else if media_type.as_str().starts_with("video/") {
        MediaKind::Video
    } else {
        MediaKind::File
    }
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

fn encode_base32(data: &[u8], out: &mut String) {
    let mut accumulator: u32 = 0;
    let mut bits: u32 = 0;
    for byte in data {
        accumulator = (accumulator << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32_ALPHABET[((accumulator >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(BASE32_ALPHABET[((accumulator << (5 - bits)) & 0x1f) as usize] as char);
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(char::from_digit((byte >> 4) as u32, 16).expect("nibble"));
        encoded.push(char::from_digit((byte & 0x0f) as u32, 16).expect("nibble"));
    }
    encoded
}

fn decode_base32_into(value: &str) -> Result<[u8; 32], String> {
    let mut output = [0u8; 32];
    let mut accumulator: u32 = 0;
    let mut bits: u32 = 0;
    let mut index = 0usize;
    for byte in value.bytes() {
        let digit = BASE32_ALPHABET
            .iter()
            .position(|candidate| *candidate == byte)
            .ok_or_else(|| "invalid base32 character".to_string())? as u32;
        accumulator = (accumulator << 5) | digit;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            if index >= output.len() {
                return Err("AssetId decoded length is invalid".to_string());
            }
            output[index] = (accumulator >> bits) as u8;
            index += 1;
        }
    }
    if index != output.len() || (bits > 0 && accumulator & ((1 << bits) - 1) != 0) {
        return Err("AssetId has non-canonical trailing bits".to_string());
    }
    Ok(output)
}

fn decode_hex(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        || value != value.to_ascii_lowercase()
    {
        return Err("digest must be 64 lowercase hexadecimal characters".to_string());
    }
    let mut digest = [0u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = (pair[0] as char).to_digit(16).expect("validated hex");
        let low = (pair[1] as char).to_digit(16).expect("validated hex");
        digest[index] = ((high << 4) | low) as u8;
    }
    Ok(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image_payload(with_geometry: bool) -> AssetPayload {
        let digest = [0u8; 32];
        AssetPayload {
            asset_ref: AssetRef {
                asset_id: AssetId::from_digest(digest),
                media_type: MediaType::parse("image/png").unwrap(),
                byte_length: 4,
                orientation: with_geometry.then_some(1),
                encoded_width: with_geometry.then_some(1000),
                encoded_height: with_geometry.then_some(500),
                display_width: with_geometry.then_some(1000),
                display_height: with_geometry.then_some(500),
            },
            media_kind: MediaKind::Image,
            generation: 7,
            digest: ContentHash::from_digest(digest),
            lease_id: "lease-1".to_string(),
            lease_expiry_unix_ms: 2_000,
            bytes: vec![1, 2, 3, 4],
        }
    }

    fn premise(view: Option<CropRect>) -> AssetPremise {
        AssetPremise {
            ordinal: 1,
            asset_id: AssetId::from_digest([0u8; 32]),
            media_type: MediaType::parse("image/png").unwrap(),
            view,
        }
    }

    #[test]
    fn accepted_asset_wire_types_are_exact_and_closed() {
        let payload = image_payload(false);
        let proof = payload.lease_proof();
        let wire = serde_json::to_value(&proof).unwrap();
        assert_eq!(wire["generation"], 7);
        assert_eq!(wire["lease_expiry_unix_ms"], 2_000);
        assert_eq!(wire["digest"]["algorithm"], "blake3-256");
        assert_eq!(wire["digest"]["digest"].as_str().unwrap().len(), 64);
        assert!(wire["asset_ref"]["orientation"].is_null());
        assert!(
            serde_json::from_value::<AssetLeaseProof>(serde_json::json!({
                "asset_ref": wire["asset_ref"],
                "media_kind": "image",
                "generation": 7,
                "digest": {"algorithm":"sha256","digest":"00".repeat(32)},
                "lease_id":"lease-1",
                "lease_expiry_unix_ms":2000
            }))
            .is_err()
        );
    }

    #[test]
    fn geometry_is_required_only_for_a_crop() {
        let whole = image_payload(false);
        assert!(validate_asset_payload(&premise(None), &whole, 4).is_ok());
        let crop = premise(Some(
            CropRect::new(100_000, 200_000, 600_000, 600_000).unwrap(),
        ));
        assert!(validate_asset_payload(&crop, &whole, 4).is_err());

        let with_geometry = image_payload(true);
        let proof = with_geometry.lease_proof();
        let bounds = materialized_view(&crop, &proof).unwrap().unwrap();
        assert_eq!(
            (bounds.left(), bounds.top(), bounds.right(), bounds.bottom()),
            (100, 100, 600, 300)
        );
    }

    #[test]
    fn payload_identity_length_bound_and_expiry_fail_closed() {
        let premise = premise(None);
        let mut payload = image_payload(false);
        assert!(validate_asset_payload_for_send(&premise, &payload, 4, 1_999).is_ok());
        assert!(validate_asset_payload_for_send(&premise, &payload, 4, 2_000).is_err());
        payload.bytes.push(5);
        assert!(validate_asset_payload(&premise, &payload, 5).is_err());
        payload.bytes.pop();
        payload.digest = ContentHash::from_digest([1u8; 32]);
        assert!(validate_asset_payload(&premise, &payload, 4).is_err());
    }

    #[test]
    fn canonical_identity_and_media_type_forms() {
        let canonical = AssetId::from_digest([0u8; 32]);
        assert_eq!(
            canonical.as_str(),
            "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert!(AssetId::parse(canonical.as_str()).is_ok());
        assert!(
            AssetId::parse("ast_b3_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").is_err()
        );
        assert!(MediaType::parse("application/vnd.example+json").is_ok());
        assert!(MediaType::parse("Image/PNG").is_err());
    }

    #[test]
    fn deny_seam_refuses_any_asset_premise() {
        let mut seam = DenyAssetParts;
        let error = seam
            .prepare_assets(&[premise(None)])
            .expect_err("asset part refused");
        assert_eq!(error.code, codes::UNSUPPORTED_MODALITY);
        assert!(!error.retryable);
        assert_eq!(error.outcome, ChannelOutcome::NotApplied);
        assert!(seam.prepare_assets(&[]).unwrap().is_empty());
    }
}
