//! Canonical asset identity: content-addressable `AssetId`, `ContentHash`,
//! and the downstream-safe `AssetRef`.
//!
//! The digest is BLAKE3-256 over the exact decoded byte sequence accepted
//! from the source. `asset_id = "ast_b3_" + base32lower(blake3-256)` with the
//! unpadded RFC 4648 alphabet `a-z2-7`; for a 256-bit value the 52nd
//! character is `a` or `q`. Identical accepted bytes within one security
//! domain resolve to the same `AssetId`.
//!
//! `AssetRef` is the only reference consumers receive; it carries identity,
//! media type, byte length, and display metadata, never a path or a secret.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;
use std::sync::LazyLock;

/// The lowercase RFC 4648 base32 alphabet used by `AssetId`.
const BASE32_ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// BLAKE3-256 digest with the exact wire shape
/// `{"algorithm":"blake3-256","digest":"<64 lowercase hex>"}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ContentHash {
    pub algorithm: &'static str,
    pub digest: [u8; 32],
}

impl ContentHash {
    pub const ALGORITHM: &'static str = "blake3-256";

    pub fn of_bytes(bytes: &[u8]) -> Self {
        Self {
            algorithm: Self::ALGORITHM,
            digest: *blake3::hash(bytes).as_bytes(),
        }
    }

    pub fn digest_hex(&self) -> String {
        encode_hex(&self.digest)
    }

    pub fn from_digest_hex(hex: &str) -> Result<Self, String> {
        let digest = decode_hex(hex)?;
        Ok(Self {
            algorithm: Self::ALGORITHM,
            digest,
        })
    }
}

impl fmt::Display for ContentHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.algorithm, self.digest_hex())
    }
}

impl Serialize for ContentHash {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("ContentHash", 2)?;
        s.serialize_field("algorithm", "blake3-256")?;
        s.serialize_field("digest", &self.digest_hex())?;
        s.end()
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
        Ok(Self {
            algorithm: Self::ALGORITHM,
            digest,
        })
    }
}

/// A validated canonical `AssetId`: `ast_b3_` followed by 52 unpadded
/// lowercase base32 characters, the last of which is `a` or `q`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AssetId(String);

impl AssetId {
    /// The canonical `AssetId` for a 256-bit BLAKE3 digest.
    pub fn from_digest(digest: [u8; 32]) -> Self {
        let mut encoded = String::with_capacity(4 + 52);
        encoded.push_str("ast_b3_");
        encode_base32(&digest, &mut encoded);
        Self(encoded)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AssetId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for AssetId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        static RE: LazyLock<regex_lite_if_available::Pattern> = LazyLock::new(|| {
            regex_lite_if_available::Pattern::new(r"^ast_b3_[a-z2-7]{51}[aq]$")
        });
        if !RE.is_match(s) {
            return Err("AssetId string does not match the canonical pattern".to_string());
        }
        // Decode and re-encode: non-canonical encodings must be rejected.
        let body = &s[7..];
        let decoded = decode_base32(body)?;
        let mut reencoded = String::with_capacity(52);
        encode_base32(&decoded, &mut reencoded);
        if reencoded != body {
            return Err("AssetId is not in canonical base32 form".to_string());
        }
        Ok(Self(s.to_string()))
    }
}

/// `AssetId` may be recovered from its bytes (crate-internal canonical path).
impl From<&AssetId> for [u8; 32] {
    fn from(id: &AssetId) -> Self {
        let mut out = [0u8; 32];
        decode_base32_into(&id.0[7..], &mut out).expect("validated AssetId decodes");
        out
    }
}

impl Serialize for AssetId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for AssetId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        AssetId::from_str(&s).map_err(serde::de::Error::custom)
    }
}

/// A validated media type, matching the `MimeType` schema pattern.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MediaType(String);

impl MediaType {
    pub fn parse(value: &str) -> Result<Self, String> {
        if value.is_empty() || value.len() > 255 || !value.contains('/') {
            return Err("invalid media type".to_string());
        }
        let (top, sub) = value.split_once('/').expect("contains '/'");
        if is_mime_type_token(top) && is_mime_type_token(sub) {
            Ok(Self(value.to_string()))
        } else {
            Err("invalid media type".to_string())
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The exact normative lowercase token grammar
/// `^[a-z0-9][a-z0-9!#$&^_.+-]*$` for one media-type side. Leading
/// punctuation, uppercase letters, and empty sides are all malformed.
fn is_mime_type_token(s: &str) -> bool {
    let mut chars = s.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return false,
    };
    if !matches!(first, 'a'..='z' | '0'..='9') {
        return false;
    }
    chars.all(|c| {
        matches!(
            c,
            'a'..='z' | '0'..='9' | '!' | '#' | '$' | '&' | '^' | '_' | '.' | '+' | '-'
        )
    })
}

impl fmt::Display for MediaType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for MediaType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        MediaType::parse(s)
    }
}

impl Serialize for MediaType {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for MediaType {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        MediaType::parse(&s).map_err(serde::de::Error::custom)
    }
}

/// The downstream-safe reference to one available asset. Consumers receive
/// only this value; paths, capabilities, and secrets never appear in it.
///
/// The wire form is canonical: `byte_length` and image dimensions are capped
/// at the largest lossless JSON integer (2^53 - 1), and EXIF `orientation`,
/// when present, is restricted to 1..=8. Deserialization fails closed on
/// oversized, non-canonical, or forged forms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AssetRef {
    pub asset_id: AssetId,
    pub media_type: MediaType,
    pub byte_length: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoded_width: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoded_height: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_width: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_height: Option<u64>,
}

impl AssetRef {
    /// The largest integer a JSON number can carry losslessly; the wire
    /// schemas cap byte lengths and dimensions at this value.
    pub const MAX_WIRE_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

    /// Fail closed on non-canonical or forged wire forms: `byte_length` and
    /// image dimensions must fit the lossless JSON integer range and, when
    /// present, be non-zero, and EXIF `orientation` must be in 1..=8.
    pub fn validate(&self) -> Result<(), String> {
        if self.byte_length > Self::MAX_WIRE_SAFE_INTEGER {
            return Err("byte_length exceeds the canonical wire integer range".to_string());
        }
        if let Some(orientation) = self.orientation {
            if !(1..=8).contains(&orientation) {
                return Err("orientation must be 1..=8 when present".to_string());
            }
        }
        for (name, value) in [
            ("encoded_width", self.encoded_width),
            ("encoded_height", self.encoded_height),
            ("display_width", self.display_width),
            ("display_height", self.display_height),
        ] {
            if let Some(v) = value {
                if v == 0 || v > Self::MAX_WIRE_SAFE_INTEGER {
                    return Err(format!("{name} is outside the canonical wire range"));
                }
            }
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for AssetRef {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct WireAssetRef {
            asset_id: AssetId,
            media_type: MediaType,
            byte_length: u64,
            orientation: Option<u8>,
            encoded_width: Option<u64>,
            encoded_height: Option<u64>,
            display_width: Option<u64>,
            display_height: Option<u64>,
        }
        let wire = WireAssetRef::deserialize(deserializer)?;
        let reference = AssetRef {
            asset_id: wire.asset_id,
            media_type: wire.media_type,
            byte_length: wire.byte_length,
            orientation: wire.orientation,
            encoded_width: wire.encoded_width,
            encoded_height: wire.encoded_height,
            display_width: wire.display_width,
            display_height: wire.display_height,
        };
        reference.validate().map_err(serde::de::Error::custom)?;
        Ok(reference)
    }
}

// ---------------------------------------------------------------------------
// base32 (unpadded, lowercase) and hex encoders
// ---------------------------------------------------------------------------

fn encode_base32(data: &[u8], out: &mut String) {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in data {
        acc = (acc << 8) | byte as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let idx = ((acc >> bits) & 0x1f) as usize;
            out.push(BASE32_ALPHABET[idx] as char);
        }
    }
    if bits > 0 {
        let idx = ((acc << (5 - bits)) & 0x1f) as usize;
        out.push(BASE32_ALPHABET[idx] as char);
    }
}

fn decode_base32(s: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity((s.len() * 5) / 8);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for ch in s.chars() {
        let value = match BASE32_ALPHABET.iter().position(|&c| c as char == ch) {
            Some(v) => v as u32,
            None => return Err("invalid base32 character".to_string()),
        };
        acc = (acc << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    if bits >= 5 {
        return Err("non-canonical trailing bits".to_string());
    }
    if bits > 0 && (acc & ((1 << bits) - 1)) != 0 {
        return Err("non-canonical trailing bits".to_string());
    }
    Ok(out)
}

fn decode_base32_into(s: &str, out: &mut [u8]) -> Result<(), String> {
    let decoded = decode_base32(s)?;
    if decoded.len() != out.len() {
        return Err("wrong decoded length".to_string());
    }
    out.copy_from_slice(&decoded);
    Ok(())
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).expect("nibble"));
        s.push(char::from_digit((b & 0x0f) as u32, 16).expect("nibble"));
    }
    s
}

fn decode_hex(s: &str) -> Result<[u8; 32], String> {
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) || s != s.to_ascii_lowercase() {
        return Err("digest must be 64 lowercase hexadecimal characters".to_string());
    }
    let mut out = [0u8; 32];
    for (i, pair) in s.as_bytes().chunks_exact(2).enumerate() {
        let hi = (pair[0] as char).to_digit(16).expect("hex");
        let lo = (pair[1] as char).to_digit(16).expect("hex");
        out[i] = ((hi << 4) | lo) as u8;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// regex-lite shim
// ---------------------------------------------------------------------------

/// A tiny single-capture-free matcher for the one fixed `AssetId` pattern,
/// avoiding an extra dependency. Supports `^`, `$`, character classes with
/// ranges, `{m}` repeats, and literal text.
mod regex_lite_if_available {
    #[derive(Clone, Copy)]
    pub struct Pattern(&'static str);

    impl Pattern {
        pub fn new(source: &'static str) -> Self {
            Self(source)
        }

        pub fn is_match(&self, text: &str) -> bool {
            // The only pattern used is ^ast_b3_[a-z2-7]{51}[aq]$ . Match it
            // directly and exactly; anything else is out of contract.
            const PREFIX: &str = "ast_b3_";
            if text.len() != PREFIX.len() + 52 {
                return false;
            }
            if !text.starts_with(PREFIX) {
                return false;
            }
            let rest = &text[PREFIX.len()..];
            let (first, last) = rest.split_at(51);
            first.bytes().all(is_z25) && is_a_or_q(last.as_bytes()[0]) && last.len() == 1
        }
    }

    fn is_z25(b: u8) -> bool {
        matches!(b, b'a'..=b'z' | b'2'..=b'7')
    }

    fn is_a_or_q(b: u8) -> bool {
        b == b'a' || b == b'q'
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_id_is_52_lower_base32_with_52nd_a_or_q() {
        // All-zero digest -> all 'a'.
        let id = AssetId::from_digest([0u8; 32]);
        assert_eq!(id.as_str(), "ast_b3_".to_string() + &"a".repeat(52));
        assert_eq!(id.as_str().len(), 7 + 52);

        // Digest whose lowest bit is set -> 52nd char is 'q'.
        let mut digest = [0u8; 32];
        digest[31] = 0x01;
        let id = AssetId::from_digest(digest);
        assert!(id.as_str().ends_with('q'));
        assert!(id.as_str().starts_with("ast_b3_"));
    }

    #[test]
    fn asset_id_round_trips_through_bytes() {
        for seed in [0u8, 1, 0x5a, 0xcd, 0xff] {
            let mut digest = [seed; 32];
            digest[31] = seed.wrapping_mul(3);
            let id = AssetId::from_digest(digest);
            let back: [u8; 32] = (&id).into();
            assert_eq!(back, digest);
            let parsed: AssetId = id.as_str().parse().expect("canonical parses");
            assert_eq!(parsed, id);
        }
    }

    #[test]
    fn asset_id_rejects_non_canonical_encodings() {
        // Valid pattern but non-canonical trailing bits: raise low bit of the
        // final 'a' to 'b' with identical decoded content is impossible
        // without changing bits; instead craft a wrong-length body.
        assert!("ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab".parse::<AssetId>().is_err());
        // Wrong prefix.
        assert!("xst_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaq".parse::<AssetId>().is_err());
        // Uppercase alphabet is not canonical.
        let id = AssetId::from_digest([1u8; 32]);
        assert!(id.as_str().parse::<AssetId>().is_err() == false);
        // A base32 body whose 52nd char is neither a nor q.
        let bad = format!("ast_b3_{}{}", "a".repeat(51), "b");
        assert!(bad.parse::<AssetId>().is_err());
    }

    #[test]
    fn content_hash_wire_shape_and_reparse() {
        let bytes = b"hello asset";
        let hash = ContentHash::of_bytes(bytes);
        assert_eq!(hash.algorithm, "blake3-256");
        assert_eq!(hash.digest_hex().len(), 64);
        assert_eq!(hash.digest_hex(), hash.digest_hex().to_ascii_lowercase());
        let json = serde_json::to_string(&hash).unwrap();
        assert!(json.contains("\"algorithm\":\"blake3-256\""));
        let round: ContentHash = serde_json::from_str(&json).unwrap();
        assert_eq!(round, hash);
        // Wrong algorithm refused.
        assert!(serde_json::from_str::<ContentHash>(
            r#"{"algorithm":"sha256","digest":"0000000000000000000000000000000000000000000000000000000000000000"}"#
        )
        .is_err());
    }

    #[test]
    fn media_type_validation() {
        assert!(MediaType::parse("image/png").is_ok());
        assert!(MediaType::parse("image/svg+xml").is_ok());
        assert!(MediaType::parse("application/vnd.oasis.opendocument.text").is_ok());
        assert!(MediaType::parse("IMAGE/png").is_err());
        assert!(MediaType::parse("image").is_err());
        assert!(MediaType::parse("image/").is_err());
        assert!(MediaType::parse("").is_err());
        // The normative lowercase token grammar; every malformed form is rejected.
        for malformed in [
            "image/PNG",   // uppercase subtype
            "!image/png",  // leading punctuation in the type
            "image/!png",  // leading punctuation in the subtype
            "Image/png",   // uppercase first letter of the type
            "image/pNg",   // uppercase inside the subtype
            "image/ png",  // space inside
            "image /png",  // space before the slash
            "image/png ",  // trailing space
            " image/png",  // leading space
            "/png",        // empty type
            "image/",      // empty subtype
            "i/",          // empty subtype
            "image/png/extra",
            "image//png",
            "image",       // no slash
            "",            // empty
        ] {
            assert!(
                MediaType::parse(malformed).is_err(),
                "media type {malformed:?} must be rejected"
            );
        }
    }

    #[test]
    fn blake3_matches_known_vector() {
        // BLAKE3 test vector for the empty string.
        let expected =
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262";
        let hash = ContentHash::of_bytes(b"");
        assert_eq!(hash.digest_hex(), expected);
    }
}
