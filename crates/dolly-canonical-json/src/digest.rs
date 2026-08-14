use crate::error::CanonicalError;
use serde::de::{self, Deserialize, Deserializer};
use serde::ser::{Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::fmt;
use std::str::FromStr;
use subtle::ConstantTimeEq;

/// Owned immutable canonical JSON bytes.
#[derive(Clone, PartialEq, Eq)]
pub struct CanonicalBytes {
    bytes: Vec<u8>,
}

impl CanonicalBytes {
    pub(crate) fn from_vec(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.bytes
    }
}

impl AsRef<[u8]> for CanonicalBytes {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

impl fmt::Debug for CanonicalBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.bytes, f)
    }
}

impl fmt::Display for CanonicalBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Display as a lossy UTF-8 string for diagnostics.
        match std::str::from_utf8(&self.bytes) {
            Ok(s) => f.write_str(s),
            Err(_) => fmt::Debug::fmt(&self.bytes, f),
        }
    }
}

/// A SHA-256 digest: exactly 32 bytes.
///
/// Its canonical text spelling is `sha256:` followed by 64 lowercase hex digits.
#[derive(Clone, Eq)]
pub struct Sha256Digest {
    bytes: [u8; 32],
}

impl Sha256Digest {
    /// Construct from a raw 32-byte array.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self { bytes }
    }

    /// Construct from a slice, rejecting anything that is not exactly 32 bytes.
    pub fn from_slice(slice: &[u8]) -> Result<Self, CanonicalError> {
        if slice.len() != 32 {
            return Err(CanonicalError::digest_mismatch(format!(
                "SHA-256 digest must be exactly 32 bytes, got {}",
                slice.len()
            )));
        }
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(slice);
        Ok(Self { bytes })
    }

    /// Returns the raw 32 bytes.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.bytes
    }

    /// Compute a SHA-256 digest over the given bytes.
    pub fn compute(input: &[u8]) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(input);
        let result = hasher.finalize();
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&result);
        Self { bytes }
    }

    /// Verify that the given bytes hash to this digest, in constant time.
    ///
    /// Returns `Ok(())` if they match, or `CORE_DIGEST_MISMATCH` if not.
    pub fn verify_bytes(&self, input: &[u8]) -> Result<(), CanonicalError> {
        let computed = Sha256Digest::compute(input);
        if self.bytes.ct_eq(&computed.bytes).into() {
            Ok(())
        } else {
            Err(CanonicalError::digest_mismatch(
                "digest does not match canonical bytes",
            ))
        }
    }

    /// Returns the canonical string: `sha256:` + 64 lowercase hex digits.
    pub fn to_canonical_string(&self) -> String {
        format!("sha256:{}", hex::encode(self.bytes))
    }
}

impl fmt::Debug for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_canonical_string())
    }
}

impl fmt::Display for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_canonical_string())
    }
}

impl FromStr for Sha256Digest {
    type Err = CanonicalError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if !s.starts_with("sha256:") {
            return Err(CanonicalError::digest_mismatch(
                "digest must start with 'sha256:'",
            ));
        }
        let hex_part = &s[7..];
        if hex_part.len() != 64 {
            return Err(CanonicalError::digest_mismatch(format!(
                "digest hex part must be 64 characters, got {}",
                hex_part.len()
            )));
        }
        // Reject uppercase hex
        if hex_part.chars().any(|c| c.is_ascii_uppercase()) {
            return Err(CanonicalError::digest_mismatch(
                "digest hex digits must be lowercase",
            ));
        }
        let bytes = hex::decode(hex_part)
            .map_err(|_| CanonicalError::digest_mismatch("digest hex is not valid hexadecimal"))?;
        Self::from_slice(&bytes)
    }
}

impl PartialEq for Sha256Digest {
    fn eq(&self, other: &Self) -> bool {
        // Use constant-time comparison for authority-sensitive equality.
        self.bytes.ct_eq(&other.bytes).into()
    }
}

impl std::hash::Hash for Sha256Digest {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.bytes.hash(state);
    }
}

impl Serialize for Sha256Digest {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_canonical_string())
    }
}

impl<'de> Deserialize<'de> for Sha256Digest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Sha256Digest::from_str(&s).map_err(de::Error::custom)
    }
}
