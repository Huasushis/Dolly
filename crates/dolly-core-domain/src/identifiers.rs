use serde::de::{self, Deserialize, Deserializer};
use serde::ser::{Serialize, Serializer};
use std::fmt;

use crate::shared;

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

const LOCAL_ID_PATTERN: &str = r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
const LOCAL_ID_MAX_UTF8_BYTES: usize = 63;

fn validate_local_id(s: &str) -> Result<(), String> {
    let bytes = s.len();
    if !(1..=LOCAL_ID_MAX_UTF8_BYTES).contains(&bytes) {
        return Err(format!(
            "local identifier must be 1..={LOCAL_ID_MAX_UTF8_BYTES} UTF-8 bytes, got {bytes}"
        ));
    }
    if !regex_match(LOCAL_ID_PATTERN, s) {
        return Err(format!("local identifier must match {LOCAL_ID_PATTERN}"));
    }
    Ok(())
}

const EXTENSION_ID_PATTERN: &str =
    r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){2,}$";
const EXTENSION_ID_MAX_UTF8_BYTES: usize = 255;

fn validate_extension_id(s: &str) -> Result<(), String> {
    let bytes = s.len();
    if bytes > EXTENSION_ID_MAX_UTF8_BYTES {
        return Err(format!(
            "ExtensionId must be at most {EXTENSION_ID_MAX_UTF8_BYTES} UTF-8 bytes, got {bytes}"
        ));
    }
    if !regex_match(EXTENSION_ID_PATTERN, s) {
        return Err(
            "ExtensionId must match reverse-DNS grammar with at least three labels".to_string(),
        );
    }
    Ok(())
}

const UUID_V7_PATTERN: &str =
    r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

fn validate_uuid_v7(s: &str) -> Result<(), String> {
    if !regex_match(UUID_V7_PATTERN, s) {
        return Err(
            "UuidV7 must be lowercase canonical RFC-9562 v7 with RFC variant bits".to_string(),
        );
    }
    Ok(())
}

/// Minimal regex matcher for fixed patterns used by identifier validation.
/// Patterns here are simple enough for a hand-rolled DFA-free matcher.
fn regex_match(pattern: &str, text: &str) -> bool {
    // We compile to the same semantics using a small regex implementation.
    // For correctness and simplicity, we validate by structure since the
    // patterns are fixed and well-defined.
    shared::match_pattern(pattern, text)
}

// ---------------------------------------------------------------------------
// Macro-like newtype generation for local IDs
// ---------------------------------------------------------------------------

macro_rules! local_id_type {
    ($name:ident, $doc:expr) => {
        #[doc = $doc]
        #[derive(Clone, PartialEq, Eq, Hash)]
        pub struct $name(String);

        impl $name {
            pub fn from_string(s: String) -> Result<Self, String> {
                validate_local_id(&s)?;
                Ok(Self(s))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", stringify!($name), self.0)
            }
        }

        impl std::str::FromStr for $name {
            type Err = String;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                validate_local_id(s)?;
                Ok(Self(s.to_owned()))
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let s = String::deserialize(deserializer)?;
                Self::from_string(s).map_err(de::Error::custom)
            }
        }
    };
}

local_id_type!(
    InstanceId,
    "A human-configured local identifier for one Dolly instance."
);
local_id_type!(PageId, "A human-configured local identifier for one Page.");
local_id_type!(
    ModuleId,
    "A human-configured local identifier for one Module."
);
// ---------------------------------------------------------------------------
// SecretRef
// ---------------------------------------------------------------------------

/// An opaque Host-managed reference to secret material.
///
/// The reference identifies material without carrying the material itself.
/// Only the Host secret authority may turn it into bytes at the point of use;
/// this type deliberately has no accessor for secret contents.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SecretRef(String);

impl SecretRef {
    pub fn from_string(s: String) -> Result<Self, String> {
        validate_secret_ref(&s)?;
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn validate_secret_ref(value: &str) -> Result<(), String> {
    if !(10..=255).contains(&value.len()) || !value.starts_with("secret://") {
        return Err("SecretRef must use the secret:// URI form".to_string());
    }
    let name = &value["secret://".len()..];
    if name.is_empty()
        || name.starts_with('/')
        || name.ends_with('/')
        || name.contains("//")
        || name.contains("..")
        || name.bytes().any(|byte| {
            !(byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'/' | b'_' | b'-' | b'.'))
        })
    {
        return Err("SecretRef contains an invalid reference name".to_string());
    }
    Ok(())
}

impl fmt::Display for SecretRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for SecretRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretRef(<redacted>)")
    }
}

impl std::str::FromStr for SecretRef {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::from_string(value.to_owned())
    }
}

impl Serialize for SecretRef {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SecretRef {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::from_string(value).map_err(de::Error::custom)
    }
}

// ---------------------------------------------------------------------------
// ExtensionId
// ---------------------------------------------------------------------------

/// A reverse-DNS Extension identifier with at least three labels.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct ExtensionId(String);

impl ExtensionId {
    pub fn from_string(s: String) -> Result<Self, String> {
        validate_extension_id(&s)?;
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ExtensionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for ExtensionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ExtensionId({})", self.0)
    }
}

impl std::str::FromStr for ExtensionId {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        validate_extension_id(s)?;
        Ok(Self(s.to_owned()))
    }
}

impl Serialize for ExtensionId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ExtensionId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Self::from_string(s).map_err(de::Error::custom)
    }
}

// ---------------------------------------------------------------------------
// ActionName
// ---------------------------------------------------------------------------

/// An action name: an owned `ExtensionId` followed by one or more operation labels.
///
/// Constructed via `parse_for_owner` which requires the exact owner prefix.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct ActionName {
    raw: String,
    owner_end: usize, // byte index where the owner ends (before the first dot of operations)
}

impl ActionName {
    /// Parse an action name, requiring that it starts with the exact `owner`
    /// ExtensionId followed by at least one valid operation label.
    pub fn parse_for_owner(owner: &ExtensionId, s: &str) -> Result<Self, String> {
        let owner_str = owner.as_str();
        if !s.starts_with(owner_str) {
            return Err(format!(
                "ActionName must start with owner ExtensionId '{owner_str}'"
            ));
        }
        let rest = &s[owner_str.len()..];
        if !rest.starts_with('.') {
            return Err(
                "ActionName must have at least one operation label after the owner".to_string(),
            );
        }
        // Validate the full name matches the ActionName grammar
        let action_pattern =
            r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){3,}$";
        if !shared::match_pattern(action_pattern, s) {
            return Err("ActionName must match the action name grammar".to_string());
        }
        if s.len() > 255 {
            return Err("ActionName must be at most 255 bytes".to_string());
        }
        // Validate each operation label after the owner
        let operation_part = &rest[1..]; // skip the dot
        for label in operation_part.split('.') {
            if !shared::match_pattern(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", label) {
                return Err(format!("invalid operation label: {label}"));
            }
        }

        Ok(Self {
            raw: s.to_owned(),
            owner_end: owner_str.len(),
        })
    }

    /// Returns the owner ExtensionId portion.
    pub fn owner(&self) -> ExtensionId {
        // SAFETY: we validated the owner at construction time
        self.raw[..self.owner_end].parse().expect("owner is valid")
    }

    /// Returns the full action name string.
    pub fn as_str(&self) -> &str {
        &self.raw
    }
}

impl fmt::Display for ActionName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.raw)
    }
}

impl fmt::Debug for ActionName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ActionName({})", self.raw)
    }
}

impl Serialize for ActionName {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.raw)
    }
}

impl<'de> Deserialize<'de> for ActionName {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let _ = String::deserialize(deserializer)?;
        Err(de::Error::custom(
            "ActionName deserialization requires an explicit ExtensionId owner; use ActionName::parse_for_owner",
        ))
    }
}

// ---------------------------------------------------------------------------
// UuidV7
// ---------------------------------------------------------------------------

/// A lowercase canonical RFC-9562 UUIDv7 string with RFC variant bits checked.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct UuidV7(String);

impl UuidV7 {
    pub fn from_string(s: String) -> Result<Self, String> {
        validate_uuid_v7(&s)?;
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for UuidV7 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for UuidV7 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "UuidV7({})", self.0)
    }
}

impl std::str::FromStr for UuidV7 {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        validate_uuid_v7(s)?;
        Ok(Self(s.to_owned()))
    }
}

impl Serialize for UuidV7 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for UuidV7 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Self::from_string(s).map_err(de::Error::custom)
    }
}

// ---------------------------------------------------------------------------
// Transparent UUIDv7 identity wrappers
// ---------------------------------------------------------------------------

macro_rules! uuid_v7_wrapper {
    ($name:ident, $doc:expr) => {
        #[doc = $doc]
        #[derive(Clone, PartialEq, Eq, Hash)]
        #[repr(transparent)]
        pub struct $name(UuidV7);

        impl $name {
            pub fn from_uuid_v7(uuid: UuidV7) -> Self {
                Self(uuid)
            }

            pub fn as_str(&self) -> &str {
                self.0.as_str()
            }

            pub fn as_uuid_v7(&self) -> &UuidV7 {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", stringify!($name), self.0.as_str())
            }
        }

        impl std::str::FromStr for $name {
            type Err = String;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                s.parse::<UuidV7>().map(Self)
            }
        }

        impl From<UuidV7> for $name {
            fn from(uuid: UuidV7) -> Self {
                Self(uuid)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                self.0.serialize(serializer)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let uuid = UuidV7::deserialize(deserializer)?;
                Ok(Self(uuid))
            }
        }
    };
}

uuid_v7_wrapper!(
    DaemonInstallationId,
    "Durable daemon installation identity."
);
uuid_v7_wrapper!(BlockId, "Runtime-assigned Block identity.");
uuid_v7_wrapper!(ActivationId, "Runtime-assigned Activation identity.");
uuid_v7_wrapper!(TraceId, "Runtime-assigned trace identity.");
uuid_v7_wrapper!(ActionId, "Runtime-assigned action identity.");
uuid_v7_wrapper!(IngressId, "Runtime-assigned ingress identity.");
uuid_v7_wrapper!(RuntimeEventId, "Runtime-assigned event identity.");
uuid_v7_wrapper!(WorkerEpoch, "Runtime Worker incarnation identity.");
uuid_v7_wrapper!(
    ModuleStorageScopeId,
    "Host-assigned stable storage isolation identity for one logical Module."
);

// ---------------------------------------------------------------------------
// LeaseToken
// ---------------------------------------------------------------------------

/// A 32-byte capability secret encoded as canonical unpadded base64url.
///
/// `Debug` is redacted. Bytes are exposed only through `expose_bytes` and
/// canonical text only through `expose_base64url`.
#[derive(Clone, PartialEq, Eq)]
pub struct LeaseToken {
    bytes: [u8; 32],
}

impl LeaseToken {
    /// Expose the raw 32 bytes. Callers must handle this material with care.
    pub fn expose_bytes(&self) -> &[u8; 32] {
        &self.bytes
    }

    /// Expose the canonical base64url text encoding.
    pub fn expose_base64url(&self) -> String {
        encode_base64url(&self.bytes)
    }

    fn parse(s: &str) -> Result<Self, String> {
        // Must be exactly 43 characters (32 bytes * 4/3 = 42.67, rounded up to 43, no padding)
        if s.len() != 43 {
            return Err(format!("LeaseToken must be 43 characters, got {}", s.len()));
        }
        // The 43rd character must be from the normative set
        let last = s.as_bytes()[42];
        const ALLOWED_LAST: &[u8] = b"AEIMQUYcgkosw048";
        if !ALLOWED_LAST.contains(&last) {
            return Err("LeaseToken 43rd character is not in the normative set".to_string());
        }
        // Decode base64url (unpadded)
        let decoded = decode_base64url(s).map_err(|e| format!("LeaseToken decode error: {e}"))?;
        if decoded.len() != 32 {
            return Err(format!(
                "LeaseToken must decode to 32 bytes, got {}",
                decoded.len()
            ));
        }
        // Re-encode and compare
        let reencoded = encode_base64url(&decoded);
        if reencoded != s {
            return Err("LeaseToken is not canonical: decode/re-encode mismatch".to_string());
        }
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&decoded);
        Ok(Self { bytes })
    }
}

impl fmt::Debug for LeaseToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LeaseToken(<redacted>)")
    }
}

impl std::str::FromStr for LeaseToken {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

impl Serialize for LeaseToken {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.expose_base64url())
    }
}

impl<'de> Deserialize<'de> for LeaseToken {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        s.parse::<Self>().map_err(de::Error::custom)
    }
}

// ---------------------------------------------------------------------------
// Base64url encoding/decoding (no external dependency)
// ---------------------------------------------------------------------------

const B64URL_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn encode_base64url(bytes: &[u8]) -> String {
    let mut result = String::new();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
        result.push(B64URL_ALPHABET[((n >> 18) & 0x3F) as usize] as char);
        result.push(B64URL_ALPHABET[((n >> 12) & 0x3F) as usize] as char);
        result.push(B64URL_ALPHABET[((n >> 6) & 0x3F) as usize] as char);
        result.push(B64URL_ALPHABET[(n & 0x3F) as usize] as char);
        i += 3;
    }
    let remaining = bytes.len() - i;
    if remaining == 1 {
        let n = (bytes[i] as u32) << 16;
        result.push(B64URL_ALPHABET[((n >> 18) & 0x3F) as usize] as char);
        result.push(B64URL_ALPHABET[((n >> 12) & 0x3F) as usize] as char);
        // No padding for base64url
    } else if remaining == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        result.push(B64URL_ALPHABET[((n >> 18) & 0x3F) as usize] as char);
        result.push(B64URL_ALPHABET[((n >> 12) & 0x3F) as usize] as char);
        result.push(B64URL_ALPHABET[((n >> 6) & 0x3F) as usize] as char);
    }
    result
}

fn decode_base64url(s: &str) -> Result<Vec<u8>, String> {
    fn char_to_val(c: u8) -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'-' => Ok(62),
            b'_' => Ok(63),
            _ => Err(format!("invalid base64url character: {c}")),
        }
    }

    let bytes = s.as_bytes();
    let mut result = Vec::new();
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let a = char_to_val(bytes[i])?;
        let b = char_to_val(bytes[i + 1])?;
        let c = char_to_val(bytes[i + 2])?;
        let d = char_to_val(bytes[i + 3])?;
        let n = ((a as u32) << 18) | ((b as u32) << 12) | ((c as u32) << 6) | (d as u32);
        result.push((n >> 16) as u8);
        result.push((n >> 8) as u8);
        result.push(n as u8);
        i += 4;
    }
    let remaining = bytes.len() - i;
    if remaining == 2 {
        let a = char_to_val(bytes[i])?;
        let b = char_to_val(bytes[i + 1])?;
        let n = ((a as u32) << 18) | ((b as u32) << 12);
        result.push((n >> 16) as u8);
    } else if remaining == 3 {
        let a = char_to_val(bytes[i])?;
        let b = char_to_val(bytes[i + 1])?;
        let c = char_to_val(bytes[i + 2])?;
        let n = ((a as u32) << 18) | ((b as u32) << 12) | ((c as u32) << 6);
        result.push((n >> 16) as u8);
        result.push((n >> 8) as u8);
    } else if remaining == 1 {
        return Err("invalid base64url length".to_string());
    }
    Ok(result)
}
