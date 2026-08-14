use crate::error::CanonicalError;
use crate::value::{CanonicalJsonObject, CanonicalJsonValue, CanonicalNumber, compare_utf16};

/// Serialize a `CanonicalJsonValue` to RFC 8785 canonical JSON bytes.
///
/// - No BOM, no insignificant whitespace, no Unicode normalization.
/// - Array order unchanged.
/// - Object members sorted by UTF-16 code-unit sequence.
/// - String escaping per RFC 8785 / ECMAScript.
/// - Numbers formatted with `ryu-js` (ECMAScript `Number::toString` behavior).
pub(crate) fn serialize_canonical(value: &CanonicalJsonValue) -> Result<Vec<u8>, CanonicalError> {
    let mut out = Vec::new();
    write_value(&mut out, value)?;
    Ok(out)
}

fn write_value(out: &mut Vec<u8>, value: &CanonicalJsonValue) -> Result<(), CanonicalError> {
    match value {
        CanonicalJsonValue::Null => out.extend_from_slice(b"null"),
        CanonicalJsonValue::Bool(true) => out.extend_from_slice(b"true"),
        CanonicalJsonValue::Bool(false) => out.extend_from_slice(b"false"),
        CanonicalJsonValue::Number(n) => write_number(out, n)?,
        CanonicalJsonValue::String(s) => write_string(out, s),
        CanonicalJsonValue::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_value(out, item)?;
            }
            out.push(b']');
        }
        CanonicalJsonValue::Object(obj) => write_object(out, obj)?,
    }
    Ok(())
}

fn write_object(out: &mut Vec<u8>, obj: &CanonicalJsonObject) -> Result<(), CanonicalError> {
    let mut sorted: Vec<(&str, &CanonicalJsonValue)> = obj.iter().collect();
    sorted.sort_by(|a, b| compare_utf16(a.0, b.0));

    out.push(b'{');
    for (i, (key, value)) in sorted.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        write_string(out, key);
        out.push(b':');
        write_value(out, value)?;
    }
    out.push(b'}');
    Ok(())
}

fn write_number(out: &mut Vec<u8>, number: &CanonicalNumber) -> Result<(), CanonicalError> {
    let s = number.format_ecmascript();
    out.extend_from_slice(s.as_bytes());
    Ok(())
}

/// Write a JSON string per RFC 8785 §3.2.2.2 escaping rules.
///
/// - `"` and `\` are escaped.
/// - Control characters U+0000–U+001F are escaped with `\u00XX`.
/// - All other characters are written as-is (UTF-8), without normalization.
fn write_string(out: &mut Vec<u8>, s: &str) {
    out.push(b'"');
    for c in s.chars() {
        match c {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\u{0008}' => out.extend_from_slice(b"\\b"),
            '\u{000C}' => out.extend_from_slice(b"\\f"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            c if (c as u32) < 0x20 => {
                let u = c as u32;
                out.extend_from_slice(format!("\\u{:04x}", u).as_bytes());
            }
            c => {
                // Write the UTF-8 encoding of this character directly.
                let mut buf = [0u8; 4];
                let bytes = c.encode_utf8(&mut buf);
                out.extend_from_slice(bytes.as_bytes());
            }
        }
    }
    out.push(b'"');
}
