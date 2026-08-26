//! Dolly Core canonical JSON: RFC 8785 (JCS) parser, serializer, and digest.
//!
//! This crate implements the JSON Canonicalization Scheme with the Dolly Core
//! JSON profile. It is the sole location for `CanonicalBytes` and `Sha256Digest`.

mod digest;
mod error;
mod parser;
mod serializer;
mod value;

pub use digest::{CanonicalBytes, Sha256Digest};
pub use error::{CanonicalError, CanonicalErrorCode};
pub use value::{CanonicalJsonObject, CanonicalJsonValue, CanonicalNumber};

use serde::Serialize;
use serde::de::IntoDeserializer;

/// The default and hard-ceiling semantic nesting depth.
pub const MAX_SEMANTIC_JSON_NESTING_DEPTH: u16 = 64;

/// The protocol wire parse-depth limit (separate from the semantic limit).
pub const PROTOCOL_WIRE_PARSE_DEPTH: u16 = 96;

/// Maximum bytes accepted for one canonical Core JSON document.
///
/// TypeScript's schema-bundle parser uses the same 8 MiB document budget.
/// Keeping the byte bound in the shared parser prevents a Rust authority
/// reader from accepting a record that the TypeScript reader would refuse.
pub const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;

/// Positive maximum nesting depth for JSON parsing.
#[derive(Clone, Copy, Debug)]
pub struct ParseLimits {
    max_nesting_depth: u16,
    max_bytes: usize,
}

impl ParseLimits {
    /// Create a `ParseLimits` with the given maximum nesting depth.
    /// The depth must be at least 1. The shared byte budget is applied.
    pub fn new(max_nesting_depth: u16) -> Result<Self, CanonicalError> {
        Self::with_bytes(max_nesting_depth, MAX_JSON_BYTES)
    }

    /// Create limits with an explicit byte budget no larger than the shared
    /// Core ceiling.
    pub fn with_bytes(max_nesting_depth: u16, max_bytes: usize) -> Result<Self, CanonicalError> {
        if max_nesting_depth == 0 {
            return Err(CanonicalError::invalid_json(
                "max_nesting_depth must be at least 1",
            ));
        }
        if max_nesting_depth > PROTOCOL_WIRE_PARSE_DEPTH {
            return Err(CanonicalError::invalid_json(format!(
                "max_nesting_depth must not exceed PROTOCOL_WIRE_PARSE_DEPTH ({PROTOCOL_WIRE_PARSE_DEPTH}), got {max_nesting_depth}"
            )));
        }
        if max_bytes == 0 || max_bytes > MAX_JSON_BYTES {
            return Err(CanonicalError::invalid_json(format!(
                "max_bytes must be in 1..={MAX_JSON_BYTES}, got {max_bytes}"
            )));
        }
        Ok(Self {
            max_nesting_depth,
            max_bytes,
        })
    }

    /// Returns the maximum nesting depth.
    pub const fn max_nesting_depth(&self) -> u16 {
        self.max_nesting_depth
    }

    /// Returns the maximum input/output byte budget.
    pub const fn max_bytes(&self) -> usize {
        self.max_bytes
    }

    /// Semantic limit: 1..=64. The hard ceiling is 64.
    pub fn semantic(policy_limit: u16) -> Result<Self, CanonicalError> {
        if policy_limit == 0 || policy_limit > MAX_SEMANTIC_JSON_NESTING_DEPTH {
            return Err(CanonicalError::invalid_json(format!(
                "semantic depth limit must be in 1..={MAX_SEMANTIC_JSON_NESTING_DEPTH}, got {policy_limit}"
            )));
        }
        Self::with_bytes(policy_limit, MAX_JSON_BYTES)
    }

    /// Protocol wire limit: 96, with the shared document byte budget.
    pub const fn protocol_wire() -> Self {
        Self {
            max_nesting_depth: PROTOCOL_WIRE_PARSE_DEPTH,
            max_bytes: MAX_JSON_BYTES,
        }
    }
}

/// Validate raw JSON wire bytes against a nesting-depth ceiling WITHOUT
/// parsing or allocating any value tree.
///
/// This is a single left-to-right byte scan: string literals (including
/// escape sequences) are skipped atomically, so quotes inside strings never
/// affect depth; structural depth comes only from `{` and `[` outside
/// strings. Trailing content after the top-level document is rejected, but
/// no JSON grammar validation happens here — a byte scan that passes this
/// gate may still be refused by the real parser. The bound is enforced
/// BEFORE any recursive `serde_json` parse can allocate a hostile deep tree.
pub fn validate_raw_json_nesting_depth(
    input: &[u8],
    max_depth: u16,
) -> Result<(), CanonicalError> {
    if max_depth == 0 {
        return Err(CanonicalError::invalid_json(
            "max_nesting_depth must be at least 1",
        ));
    }
    let mut depth: u16 = 0;
    let mut bytes = input.iter().copied();
    loop {
        let Some(byte) = bytes.next() else {
            return Err(CanonicalError::invalid_json(
                "raw JSON nesting scan found no document",
            ));
        };
        match byte {
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            b'{' | b'[' => {
                depth += 1;
                if depth > max_depth {
                    return Err(CanonicalError::invalid_json(format!(
                        "raw JSON exceeds its {max_depth}-level nesting limit"
                    )));
                }
            }
            b'}' | b']' => {
                depth = match depth.checked_sub(1) {
                    Some(remaining) => remaining,
                    None => {
                        return Err(CanonicalError::invalid_json(
                            "unbalanced closing bracket in raw JSON",
                        ));
                    }
                };
            }
            b'"' => {
                let mut escaped = false;
                loop {
                    match bytes.next() {
                        None => {
                            return Err(CanonicalError::invalid_json(
                                "unterminated JSON string in raw scan",
                            ));
                        }
                        Some(b'"') if !escaped => break,
                        Some(b'\\') => escaped = !escaped,
                        Some(_) => escaped = false,
                    }
                }
            }
            _ => {}
        }
        if depth == 0 {
            break;
        }
    }
    for rest in bytes {
        if !matches!(rest, b' ' | b'\n' | b'\r' | b'\t') {
            return Err(CanonicalError::invalid_json(
                "trailing data after the top-level JSON document",
            ));
        }
    }
    Ok(())
}

/// Parse untrusted JSON bytes into a `CanonicalJsonValue` tree.
///
/// Enforces the Dolly Core JSON profile: rejects BOM, invalid UTF-8, lone
/// surrogates, duplicate object names, non-finite numbers, negative zero,
/// and enforces the supplied depth and byte limits.
pub fn parse_core_json(
    input: &[u8],
    limits: ParseLimits,
) -> Result<CanonicalJsonValue, CanonicalError> {
    if input.len() > limits.max_bytes() {
        return Err(CanonicalError::invalid_json(format!(
            "JSON exceeds its {}-byte limit",
            limits.max_bytes()
        )));
    }
    let parser = parser::CoreJsonParser::new(input, limits.max_nesting_depth());
    parser.parse()
}

/// Parse and then deserialize untrusted JSON bytes into a typed value.
///
/// First parses through the duplicate-rejecting Core JSON parser, then
/// deserializes the resulting `CanonicalJsonValue` into `T`.
pub fn deserialize_core_json<T: serde::de::DeserializeOwned>(
    input: &[u8],
    limits: ParseLimits,
) -> Result<T, CanonicalError> {
    let value = parse_core_json(input, limits)?;
    T::deserialize(value.into_deserializer())
        .map_err(|e| CanonicalError::invalid_json(e.to_string()))
}

/// Canonicalize a serializable value to JCS bytes and its SHA-256 digest.
///
/// Uses the default semantic depth and byte limits (64 levels, 8 MiB).
pub fn canonicalize<T: Serialize>(
    value: &T,
) -> Result<(CanonicalBytes, Sha256Digest), CanonicalError> {
    canonicalize_with_limits(
        value,
        ParseLimits::semantic(MAX_SEMANTIC_JSON_NESTING_DEPTH)?,
    )
}

/// Canonicalize a serializable value to JCS bytes and its SHA-256 digest,
/// with an explicit depth and byte limit.
pub fn canonicalize_with_limits<T: Serialize>(
    value: &T,
    limits: ParseLimits,
) -> Result<(CanonicalBytes, Sha256Digest), CanonicalError> {
    // Serialize the value to a CanonicalJsonValue tree first, so we can
    // enforce the depth limit and use our canonical serializer.
    let json_value: CanonicalJsonValue = serde_json::to_value(value)
        .map_err(|e| CanonicalError::invalid_json(e.to_string()))?
        .try_into()
        .map_err(CanonicalError::invalid_json)?;

    // Enforce semantic depth.
    let depth = json_value.semantic_depth();
    if depth > limits.max_nesting_depth() {
        return Err(CanonicalError::invalid_json(format!(
            "semantic nesting depth {depth} exceeds limit {}",
            limits.max_nesting_depth()
        )));
    }

    let bytes = serializer::serialize_canonical(&json_value)?;
    if bytes.len() > limits.max_bytes() {
        return Err(CanonicalError::invalid_json(format!(
            "canonical JSON exceeds its {}-byte limit",
            limits.max_bytes()
        )));
    }
    let digest = Sha256Digest::compute(&bytes);
    Ok((CanonicalBytes::from_vec(bytes), digest))
}

// ---------------------------------------------------------------------------
// Conversion: serde_json::Value -> CanonicalJsonValue
// ---------------------------------------------------------------------------

impl TryFrom<serde_json::Value> for CanonicalJsonValue {
    type Error = String;

    fn try_from(value: serde_json::Value) -> Result<Self, Self::Error> {
        match value {
            serde_json::Value::Null => Ok(CanonicalJsonValue::Null),
            serde_json::Value::Bool(b) => Ok(CanonicalJsonValue::Bool(b)),
            serde_json::Value::Number(n) => {
                let f = n
                    .as_f64()
                    .ok_or_else(|| format!("number {n} cannot be represented as f64"))?;
                let cn = CanonicalNumber::from_f64(f).map_err(|e| e.message)?;
                Ok(CanonicalJsonValue::Number(cn))
            }
            serde_json::Value::String(s) => {
                // Check for lone surrogates (shouldn't happen in valid Rust strings, but be safe)
                Ok(CanonicalJsonValue::String(s))
            }
            serde_json::Value::Array(arr) => {
                let items: Result<Vec<_>, _> =
                    arr.into_iter().map(CanonicalJsonValue::try_from).collect();
                Ok(CanonicalJsonValue::Array(items?))
            }
            serde_json::Value::Object(map) => {
                let mut members = Vec::new();
                for (k, v) in map {
                    members.push((k, CanonicalJsonValue::try_from(v)?));
                }
                // Check for duplicates (shouldn't happen since serde_json::Map rejects
                // duplicates with preserve_order, but be safe)
                let mut seen = std::collections::HashSet::new();
                for (k, _) in &members {
                    if !seen.insert(k.clone()) {
                        return Err(format!("duplicate object member: {k}"));
                    }
                }
                Ok(CanonicalJsonValue::Object(CanonicalJsonObject { members }))
            }
        }
    }
}

// Allow CanonicalJsonValue to be used as a serde Deserializer for deserialize_core_json
impl<'de> serde::de::IntoDeserializer<'de, CanonicalError> for CanonicalJsonValue {
    type Deserializer = CanonicalJsonValueDeserializer;

    fn into_deserializer(self) -> Self::Deserializer {
        CanonicalJsonValueDeserializer(self)
    }
}

/// A deserializer that wraps a `CanonicalJsonValue` and drives serde deserialization.
pub struct CanonicalJsonValueDeserializer(CanonicalJsonValue);

impl<'de> serde::de::IntoDeserializer<'de, CanonicalError> for CanonicalJsonValueDeserializer {
    type Deserializer = Self;

    fn into_deserializer(self) -> Self::Deserializer {
        self
    }
}

/// Enum access for a one-key `CanonicalJsonValue::Object` treated as a serde enum:
/// the single key is the variant name, the value is the variant payload.
struct CanonicalEnumAccess {
    variant: String,
    value: CanonicalJsonValue,
}

impl<'de> serde::de::EnumAccess<'de> for CanonicalEnumAccess {
    type Error = CanonicalError;
    type Variant = CanonicalJsonValueDeserializer;

    fn variant_seed<V: serde::de::DeserializeSeed<'de>>(
        self,
        seed: V,
    ) -> Result<(V::Value, Self::Variant), Self::Error> {
        let variant_name = serde::de::value::StringDeserializer::new(self.variant);
        let value = seed.deserialize(variant_name)?;
        Ok((value, CanonicalJsonValueDeserializer(self.value)))
    }
}

impl<'de> serde::de::VariantAccess<'de> for CanonicalJsonValueDeserializer {
    type Error = CanonicalError;

    fn unit_variant(self) -> Result<(), Self::Error> {
        serde::de::Deserialize::deserialize(self)
    }

    fn newtype_variant_seed<T: serde::de::DeserializeSeed<'de>>(
        self,
        seed: T,
    ) -> Result<T::Value, Self::Error> {
        seed.deserialize(self)
    }

    fn tuple_variant<V: serde::de::Visitor<'de>>(
        self,
        _len: usize,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        serde::de::Deserializer::deserialize_seq(self, visitor)
    }

    fn struct_variant<V: serde::de::Visitor<'de>>(
        self,
        _fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        serde::de::Deserializer::deserialize_map(self, visitor)
    }
}

impl<'de> serde::Deserializer<'de> for CanonicalJsonValueDeserializer {
    type Error = CanonicalError;

    fn deserialize_any<V: serde::de::Visitor<'de>>(
        self,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        match self.0 {
            CanonicalJsonValue::Null => visitor.visit_unit(),
            CanonicalJsonValue::Bool(b) => visitor.visit_bool(b),
            CanonicalJsonValue::Number(n) => {
                let f = n.as_f64();
                if f.fract() == 0.0 && f.abs() < 9007199254740992.0 {
                    if f >= 0.0 {
                        visitor.visit_u64(f as u64)
                    } else {
                        visitor.visit_i64(f as i64)
                    }
                } else {
                    visitor.visit_f64(f)
                }
            }
            CanonicalJsonValue::String(s) => visitor.visit_string(s),
            CanonicalJsonValue::Array(arr) => {
                let deserializers: Vec<_> = arr
                    .into_iter()
                    .map(CanonicalJsonValueDeserializer)
                    .collect();
                visitor.visit_seq(serde::de::value::SeqDeserializer::new(
                    deserializers.into_iter(),
                ))
            }
            CanonicalJsonValue::Object(obj) => {
                let map: std::collections::BTreeMap<String, CanonicalJsonValueDeserializer> = obj
                    .iter()
                    .map(|(k, v)| (k.to_string(), CanonicalJsonValueDeserializer(v.clone())))
                    .collect();
                visitor.visit_map(serde::de::value::MapDeserializer::new(map.into_iter()))
            }
        }
    }

    fn deserialize_option<V: serde::de::Visitor<'de>>(
        self,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        match self.0 {
            CanonicalJsonValue::Null => visitor.visit_none(),
            _ => visitor.visit_some(self),
        }
    }

    fn deserialize_enum<V: serde::de::Visitor<'de>>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        match self.0 {
            CanonicalJsonValue::String(s) => {
                visitor.visit_enum(serde::de::value::StringDeserializer::new(s))
            }
            CanonicalJsonValue::Object(obj) => {
                let mut iter = obj.iter();
                let (key, value) = iter.next().ok_or_else(|| {
                    CanonicalError::invalid_json("expected one-key object for enum")
                })?;
                if iter.next().is_some() {
                    return Err(CanonicalError::invalid_json(
                        "expected exactly one key for enum variant",
                    ));
                }
                visitor.visit_enum(CanonicalEnumAccess {
                    variant: key.to_string(),
                    value: value.clone(),
                })
            }
            _ => Err(CanonicalError::invalid_json(
                "expected string or object for enum",
            )),
        }
    }

    fn deserialize_newtype_struct<V: serde::de::Visitor<'de>>(
        self,
        _name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        visitor.visit_newtype_struct(self)
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 char str string
        bytes byte_buf unit unit_struct seq map
        struct tuple tuple_struct ignored_any identifier
    }
}
