use dolly_canonical_json::{CanonicalJsonObject, Sha256Digest};
use serde::de::{self, Deserialize, Deserializer};
use serde::ser::{Serialize, SerializeStruct, Serializer};
use std::fmt;
use std::str::FromStr;

use crate::identifiers::RuntimeEventId;

/// The outcome of a Core operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoreOutcome {
    NotApplied,
    Applied,
    Unknown,
}

impl CoreOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            CoreOutcome::NotApplied => "not_applied",
            CoreOutcome::Applied => "applied",
            CoreOutcome::Unknown => "unknown",
        }
    }
}

impl FromStr for CoreOutcome {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "not_applied" => Ok(Self::NotApplied),
            "applied" => Ok(Self::Applied),
            "unknown" => Ok(Self::Unknown),
            _ => Err(format!("unknown CoreOutcome: {s}")),
        }
    }
}

impl Serialize for CoreOutcome {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for CoreOutcome {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        s.parse::<Self>().map_err(de::Error::custom)
    }
}

/// A validated Core error code newtype.
///
/// Associated constants are provided for the seven normative codes.
/// This is a newtype, not an enum, so later normative codes can be added
/// without breaking compatibility.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct CoreErrorCode(String);

impl CoreErrorCode {
    pub const CORE_INVALID_JSON: &'static str = "CORE_INVALID_JSON";
    pub const CORE_INVALID_ID: &'static str = "CORE_INVALID_ID";
    pub const CORE_FORGED_IDENTITY: &'static str = "CORE_FORGED_IDENTITY";
    pub const CORE_ID_COLLISION: &'static str = "CORE_ID_COLLISION";
    pub const CORE_DIGEST_MISMATCH: &'static str = "CORE_DIGEST_MISMATCH";
    pub const CORE_SEQUENCE_EXHAUSTED: &'static str = "CORE_SEQUENCE_EXHAUSTED";
    pub const CORE_QUOTA_EXCEEDED: &'static str = "CORE_QUOTA_EXCEEDED";

    fn parse(s: &str) -> Result<Self, String> {
        // Validate: uppercase letters, digits, underscores, starts with letter
        if s.len() < 2 || s.len() > 96 {
            return Err("CoreErrorCode must be 2..=96 characters".to_string());
        }
        if !s.chars().next().unwrap().is_ascii_uppercase() {
            return Err("CoreErrorCode must start with an uppercase letter".to_string());
        }
        if !s
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        {
            return Err("CoreErrorCode must match ^[A-Z][A-Z0-9_]+$".to_string());
        }
        Ok(Self(s.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CoreErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for CoreErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "CoreErrorCode({})", self.0)
    }
}

impl FromStr for CoreErrorCode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

impl Serialize for CoreErrorCode {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for CoreErrorCode {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        s.parse::<Self>().map_err(de::Error::custom)
    }
}

/// The standard Core error envelope.
///
/// `code`, `retryable`, and `outcome` are normative. `retryable` is never
/// derived from the code. `correlation_id` is absent versus present.
#[derive(Clone)]
pub struct CoreErrorEnvelope {
    pub code: CoreErrorCode,
    pub retryable: bool,
    pub outcome: CoreOutcome,
    pub message: String,
    pub details: CanonicalJsonObject,
    pub correlation_id: Option<RuntimeEventId>,
}

impl CoreErrorEnvelope {
    pub fn new(
        code: CoreErrorCode,
        retryable: bool,
        outcome: CoreOutcome,
        message: String,
        details: CanonicalJsonObject,
        correlation_id: Option<RuntimeEventId>,
    ) -> Self {
        Self {
            code,
            retryable,
            outcome,
            message,
            details,
            correlation_id,
        }
    }
}

impl fmt::Debug for CoreErrorEnvelope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CoreErrorEnvelope")
            .field("code", &self.code)
            .field("retryable", &self.retryable)
            .field("outcome", &self.outcome)
            .field("message", &self.message)
            .field("details", &self.details)
            .field("correlation_id", &self.correlation_id)
            .finish()
    }
}

impl Serialize for CoreErrorEnvelope {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("CoreErrorEnvelope", 6)?;
        s.serialize_field("code", &self.code)?;
        s.serialize_field("retryable", &self.retryable)?;
        s.serialize_field("outcome", &self.outcome)?;
        s.serialize_field("message", &self.message)?;
        s.serialize_field("details", &self.details)?;
        if let Some(ref cid) = self.correlation_id {
            s.serialize_field("correlation_id", cid)?;
        }
        s.end()
    }
}

impl<'de> Deserialize<'de> for CoreErrorEnvelope {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct EnvelopeFields {
            code: CoreErrorCode,
            retryable: bool,
            outcome: CoreOutcome,
            message: String,
            details: CanonicalJsonObject,
            correlation_id: Option<RuntimeEventId>,
        }
        let f = EnvelopeFields::deserialize(deserializer)?;
        Ok(CoreErrorEnvelope::new(
            f.code,
            f.retryable,
            f.outcome,
            f.message,
            f.details,
            f.correlation_id,
        ))
    }
}

// ---------------------------------------------------------------------------
// Composite records
// ---------------------------------------------------------------------------

/// A delivery key: `(page_id, page_seq)`. Instance scope is supplied by the
/// containing instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryKey {
    pub page_id: crate::identifiers::PageId,
    pub page_seq: crate::numbers::PageSeq,
}

/// A cursor span: `(page_id, from_inclusive, to_exclusive)`. Instance scope
/// is supplied by the containing instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CursorSpan {
    pub page_id: crate::identifiers::PageId,
    pub from_inclusive: crate::numbers::PageSeq,
    pub to_exclusive: crate::numbers::PageSeq,
}

/// A frozen configuration record.
#[derive(Clone, Debug)]
pub struct FrozenConfig {
    pub revision: crate::numbers::ConfigRevision,
    pub value: CanonicalJsonObject,
    pub value_digest: Sha256Digest,
    pub schema_digest: Sha256Digest,
    pub package_digest: Sha256Digest,
}
