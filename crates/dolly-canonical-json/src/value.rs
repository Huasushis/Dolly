use crate::error::CanonicalError;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use std::collections::HashSet;
use std::fmt;

/// A canonical JSON number: a finite IEEE-754 binary64 value.
///
/// Negative zero is rejected at construction; NaN and infinity are never
/// representable because the parser rejects them before this type is built.
#[derive(Clone, Copy, PartialEq)]
pub struct CanonicalNumber(f64);

impl CanonicalNumber {
    /// Creates a `CanonicalNumber` from an `f64`, rejecting non-finite values
    /// and negative zero.
    pub fn from_f64(value: f64) -> Result<Self, CanonicalError> {
        if !value.is_finite() {
            return Err(CanonicalError::invalid_json("JSON numbers must be finite"));
        }
        if value == 0.0 && value.is_sign_negative() {
            return Err(CanonicalError::invalid_json(
                "JSON numbers must not be negative zero",
            ));
        }
        Ok(Self(value))
    }

    /// Returns the underlying `f64`.
    pub fn as_f64(self) -> f64 {
        self.0
    }

    /// Formats the number using ECMAScript `Number::toString` behavior via
    /// `ryu-js`.
    pub(crate) fn format_ecmascript(&self) -> String {
        let mut buf = ryu_js::Buffer::new();
        buf.format(self.0).to_string()
    }
}

impl fmt::Debug for CanonicalNumber {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

impl fmt::Display for CanonicalNumber {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.format_ecmascript())
    }
}

impl Serialize for CanonicalNumber {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let s = self.format_ecmascript();
        // Serialize as a raw number, not a string, so that serde_json produces
        // a numeric token. We do this by parsing the formatted string back
        // into a serde_json::Number and serializing that.
        let num: serde_json::Number = serde_json::from_str::<serde_json::Value>(&s)
            .ok()
            .and_then(|v| match v {
                serde_json::Value::Number(n) => Some(n),
                _ => None,
            })
            .ok_or_else(|| serde::ser::Error::custom("expected number"))?;
        num.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for CanonicalNumber {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let f = f64::deserialize(deserializer)?;
        CanonicalNumber::from_f64(f).map_err(de::Error::custom)
    }
}

// ---------------------------------------------------------------------------
// CanonicalJsonObject
// ---------------------------------------------------------------------------

/// An ordered map of unique string members to canonical JSON values.
///
/// Construction rejects a repeated member name. Members are stored in
/// insertion order; canonicalization sorts them by UTF-16 code-unit sequence.
#[derive(Clone, Default)]
pub struct CanonicalJsonObject {
    // We use a Vec of pairs rather than a map so we preserve insertion order
    // and can detect duplicates at construction.
    pub(crate) members: Vec<(String, CanonicalJsonValue)>,
}

impl CanonicalJsonObject {
    /// Construct from an iterator of `(name, value)` pairs.
    /// Rejects a repeated member name.
    pub fn try_from_iter<I>(iter: I) -> Result<Self, CanonicalError>
    where
        I: IntoIterator<Item = (String, CanonicalJsonValue)>,
    {
        let mut members = Vec::new();
        let mut seen = HashSet::new();
        for (name, value) in iter {
            if !seen.insert(name.clone()) {
                return Err(CanonicalError::invalid_json(format!(
                    "duplicate object member: {name}"
                )));
            }
            members.push((name, value));
        }
        Ok(Self { members })
    }

    /// Returns the value for the given member name, if present.
    pub fn get(&self, name: &str) -> Option<&CanonicalJsonValue> {
        self.members.iter().find(|(k, _)| k == name).map(|(_, v)| v)
    }

    /// Iterates over `(name, value)` pairs in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &CanonicalJsonValue)> {
        self.members.iter().map(|(k, v)| (k.as_str(), v))
    }

    /// Returns the number of members.
    pub fn len(&self) -> usize {
        self.members.len()
    }

    /// Returns `true` if there are no members.
    pub fn is_empty(&self) -> bool {
        self.members.is_empty()
    }

    /// Returns a sorted view of members for canonical serialization.
    /// Sorts by UTF-16 code-unit sequence per RFC 8785.
    pub(crate) fn sorted_members(&self) -> Vec<(&str, &CanonicalJsonValue)> {
        let mut pairs: Vec<(&str, &CanonicalJsonValue)> =
            self.members.iter().map(|(k, v)| (k.as_str(), v)).collect();
        pairs.sort_by(|a, b| compare_utf16(a.0, b.0));
        pairs
    }
}

impl fmt::Debug for CanonicalJsonObject {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map()
            .entries(self.members.iter().map(|(k, v)| (k, v)))
            .finish()
    }
}

impl PartialEq for CanonicalJsonObject {
    fn eq(&self, other: &Self) -> bool {
        // Two objects are equal if their canonical bytes are equal (same members,
        // same values, regardless of insertion order).
        if self.members.len() != other.members.len() {
            return false;
        }
        // Check that every member in self exists in other with the same value.
        for (k, v) in &self.members {
            match other.get(k) {
                Some(ov) if v == ov => {}
                _ => return false,
            }
        }
        true
    }
}

impl Eq for CanonicalJsonObject {}

impl Serialize for CanonicalJsonObject {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let sorted = self.sorted_members();
        let mut map = serializer.serialize_map(Some(sorted.len()))?;
        for (k, v) in &sorted {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for CanonicalJsonObject {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonObjectVisitor;

        impl<'de> Visitor<'de> for JsonObjectVisitor {
            type Value = CanonicalJsonObject;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a JSON object without duplicate keys")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut members = Vec::new();
                let mut seen = HashSet::new();
                while let Some((key, value)) = access.next_entry::<String, CanonicalJsonValue>()? {
                    if !seen.insert(key.clone()) {
                        return Err(de::Error::custom(format!("duplicate object member: {key}")));
                    }
                    members.push((key, value));
                }
                Ok(CanonicalJsonObject { members })
            }
        }

        deserializer.deserialize_map(JsonObjectVisitor)
    }
}

// ---------------------------------------------------------------------------
// CanonicalJsonValue
// ---------------------------------------------------------------------------

/// A canonical JSON value conforming to the Dolly Core JSON profile.
#[derive(Clone, PartialEq)]
pub enum CanonicalJsonValue {
    Null,
    Bool(bool),
    Number(CanonicalNumber),
    String(String),
    Array(Vec<CanonicalJsonValue>),
    Object(CanonicalJsonObject),
}

impl CanonicalJsonValue {
    /// Returns `true` if this is a primitive (null, bool, number, string).
    pub fn is_primitive(&self) -> bool {
        matches!(
            self,
            CanonicalJsonValue::Null
                | CanonicalJsonValue::Bool(_)
                | CanonicalJsonValue::Number(_)
                | CanonicalJsonValue::String(_)
        )
    }

    /// Returns the semantic nesting depth: primitives are 0, nonempty
    /// containers are `1 + max(child)`, empty containers are 1.
    pub fn semantic_depth(&self) -> u16 {
        match self {
            CanonicalJsonValue::Null
            | CanonicalJsonValue::Bool(_)
            | CanonicalJsonValue::Number(_)
            | CanonicalJsonValue::String(_) => 0,
            CanonicalJsonValue::Array(items) => {
                if items.is_empty() {
                    1
                } else {
                    1 + items.iter().map(|v| v.semantic_depth()).max().unwrap_or(0)
                }
            }
            CanonicalJsonValue::Object(obj) => {
                if obj.is_empty() {
                    1
                } else {
                    1 + obj
                        .iter()
                        .map(|(_, v)| v.semantic_depth())
                        .max()
                        .unwrap_or(0)
                }
            }
        }
    }
}

impl fmt::Debug for CanonicalJsonValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CanonicalJsonValue::Null => f.write_str("Null"),
            CanonicalJsonValue::Bool(b) => fmt::Debug::fmt(b, f),
            CanonicalJsonValue::Number(n) => fmt::Debug::fmt(n, f),
            CanonicalJsonValue::String(s) => fmt::Debug::fmt(s, f),
            CanonicalJsonValue::Array(a) => fmt::Debug::fmt(a, f),
            CanonicalJsonValue::Object(o) => fmt::Debug::fmt(o, f),
        }
    }
}

impl Serialize for CanonicalJsonValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            CanonicalJsonValue::Null => serializer.serialize_unit(),
            CanonicalJsonValue::Bool(b) => serializer.serialize_bool(*b),
            CanonicalJsonValue::Number(n) => n.serialize(serializer),
            CanonicalJsonValue::String(s) => serializer.serialize_str(s),
            CanonicalJsonValue::Array(a) => {
                let mut seq = serializer.serialize_seq(Some(a.len()))?;
                for v in a {
                    seq.serialize_element(v)?;
                }
                seq.end()
            }
            CanonicalJsonValue::Object(o) => o.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for CanonicalJsonValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonValueVisitor;

        impl<'de> Visitor<'de> for JsonValueVisitor {
            type Value = CanonicalJsonValue;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a canonical JSON value")
            }

            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(CanonicalJsonValue::Null)
            }

            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(CanonicalJsonValue::Null)
            }

            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(CanonicalJsonValue::Bool(v))
            }

            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(CanonicalJsonValue::Number(
                    CanonicalNumber::from_f64(v as f64).map_err(E::custom)?,
                ))
            }

            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(CanonicalJsonValue::Number(
                    CanonicalNumber::from_f64(v as f64).map_err(E::custom)?,
                ))
            }

            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                Ok(CanonicalJsonValue::Number(
                    CanonicalNumber::from_f64(v).map_err(E::custom)?,
                ))
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(CanonicalJsonValue::String(v.to_owned()))
            }

            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(CanonicalJsonValue::String(v))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut items = Vec::new();
                while let Some(v) = access.next_element()? {
                    items.push(v);
                }
                Ok(CanonicalJsonValue::Array(items))
            }

            fn visit_map<A: MapAccess<'de>>(self, access: A) -> Result<Self::Value, A::Error> {
                let obj = CanonicalJsonObject::deserialize(de::value::MapAccessDeserializer::new(
                    access,
                ))?;
                Ok(CanonicalJsonValue::Object(obj))
            }
        }

        deserializer.deserialize_any(JsonValueVisitor)
    }
}

// ---------------------------------------------------------------------------
// UTF-16 code-unit comparison (RFC 8785 §3.2.3)
// ---------------------------------------------------------------------------

/// Compare two strings by UTF-16 code-unit sequence, as required by RFC 8785.
///
/// This compares the UTF-16 encoding of each string without allocating a
/// `Vec<u16>` per comparison. It iterates over the `encode_utf16()` iterators
/// and compares element-by-element.
pub(crate) fn compare_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let mut ai = a.encode_utf16();
    let mut bi = b.encode_utf16();
    loop {
        match (ai.next(), bi.next()) {
            (Some(x), Some(y)) => match x.cmp(&y) {
                Ordering::Equal => continue,
                ord => return ord,
            },
            (Some(_), None) => return Ordering::Greater,
            (None, Some(_)) => return Ordering::Less,
            (None, None) => return Ordering::Equal,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_ordering_supplementary_plane_first() {
        // U+10000 encodes as two UTF-16 code units: 0xD800 0xDC00
        // U+E000 encodes as one UTF-16 code unit: 0xE000
        // Under UTF-16 ordering, 0xD800 < 0xE000, so U+10000 sorts first.
        let a = "\u{10000}";
        let b = "\u{E000}";
        assert_eq!(compare_utf16(a, b), std::cmp::Ordering::Less);
        // Under UTF-8 byte ordering, U+E000 (3 bytes: EE 80 80) < U+10000 (4 bytes: F0 90 80 80)
        // So UTF-8 would sort them the other way. This test confirms we use UTF-16.
        assert!(a.as_bytes() > b.as_bytes());
    }
}
