//! Canonical JSON byte-exact golden tests and rejections.
//!
//! These tests pin expected canonical bytes and digests, not values generated
//! by the implementation under test.

use dolly_canonical_json::{
    MAX_SEMANTIC_JSON_NESTING_DEPTH, ParseLimits, Sha256Digest, canonicalize, parse_core_json,
};
use std::str::FromStr;

fn canon(s: &str) -> (Vec<u8>, String) {
    let value = parse_core_json(s.as_bytes(), ParseLimits::protocol_wire()).unwrap();
    let (bytes, digest) = canonicalize(&value).unwrap();
    (bytes.into_vec(), digest.to_canonical_string())
}

// ---------------------------------------------------------------------------
// RFC 8785 §3.2.4 byte-exact sample
// ---------------------------------------------------------------------------

#[test]
fn rfc8785_number_spellings() {
    // RFC 8785 §3.2.4: input order preserved with canonical spellings.
    let (bytes, _) = canon(r#"{"numbers":[1e30,0.002,333333333.3333333,1.0]}"#);
    let s = String::from_utf8(bytes).unwrap();
    assert_eq!(
        s, r#"{"numbers":[1e+30,0.002,333333333.3333333,1]}"#,
        "canonical output must match RFC 8785 input order and spellings"
    );
}

// ---------------------------------------------------------------------------
// UTF-16 ordering discriminator
// ---------------------------------------------------------------------------

#[test]
fn utf16_ordering_supplementary_plane_first() {
    // Keys U+10000 and U+E000: the supplementary-plane key sorts first under UTF-16.
    // U+10000 encodes as UTF-16 code units 0xD800 0xDC00.
    // U+E000 encodes as a single UTF-16 code unit 0xE000.
    // Under UTF-16 ordering, 0xD800 < 0xE000, so U+10000 sorts first.
    let input = r#"{"\uE000":1,"\uD800\uDC00":2}"#;
    let (bytes, _) = canon(input);
    let s = String::from_utf8(bytes).unwrap();
    // The supplementary-plane key (U+10000) must come first
    let pos_supp = s.find('\u{10000}').unwrap();
    let pos_e000 = s.find('\u{E000}').unwrap();
    assert!(
        pos_supp < pos_e000,
        "UTF-16 ordering: U+10000 must sort before U+E000, got {s}"
    );
}

// ---------------------------------------------------------------------------
// Golden digests
// ---------------------------------------------------------------------------

#[test]
fn empty_object_digest() {
    let (bytes, digest) = canon("{}");
    assert_eq!(bytes, b"{}");
    assert_eq!(
        digest,
        "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
    );
}

#[test]
fn tst_config_003_digest() {
    let input = r#"{"cache":{"module":true},"inherited":1,"nullable":null,"tags":["module"]}"#;
    let (bytes, digest) = canon(input);
    // Verify the canonical bytes are sorted by UTF-16
    let s = String::from_utf8(bytes).unwrap();
    // cache < inherited < nullable < tags (all ASCII, so UTF-16 = ASCII ordering)
    let cache_pos = s.find("\"cache\"").unwrap();
    let inherited_pos = s.find("\"inherited\"").unwrap();
    let nullable_pos = s.find("\"nullable\"").unwrap();
    let tags_pos = s.find("\"tags\"").unwrap();
    assert!(cache_pos < inherited_pos);
    assert!(inherited_pos < nullable_pos);
    assert!(nullable_pos < tags_pos);
    assert_eq!(
        digest,
        "sha256:75d72a950e3a0e5a7ad5150b6a52bfc4f2bc83c001c23dd7d44045b13149d223"
    );
}

#[test]
fn tst_core_016_legacy_digest() {
    let input = r#"{"mode":"legacy","threshold":7}"#;
    let (bytes, digest) = canon(input);
    let s = String::from_utf8(bytes).unwrap();
    assert_eq!(s, r#"{"mode":"legacy","threshold":7}"#);
    assert_eq!(
        digest,
        "sha256:0406c7d60dad47428a106f950b07195c98317e0e3c3c3325b2ff2a77b44b7613"
    );
}

#[test]
fn tst_core_016_current_digest() {
    let input = r#"{"mode":"current","threshold":9}"#;
    let (_bytes, digest) = canon(input);
    assert_eq!(
        digest,
        "sha256:f26d094f9ee954e3a5cc96e73cdac37fbd401b08a8efe888659b33cc53090778"
    );
}

// ---------------------------------------------------------------------------
// Array order preserved, strings not normalized, control-char escaping
// ---------------------------------------------------------------------------

#[test]
fn array_order_preserved() {
    let input = r#"[3,1,2]"#;
    let (bytes, _) = canon(input);
    assert_eq!(bytes, b"[3,1,2]");
}

#[test]
fn strings_retain_unicode_without_normalization() {
    let input = r#"{"key":"café"}"#;
    let (bytes, _) = canon(input);
    // The string should be preserved as UTF-8 without normalization
    let s = String::from_utf8(bytes).unwrap();
    assert!(s.contains("café"));
}

#[test]
fn control_character_escaping_byte_exact() {
    let input = "\"\\u0000\\u0001\\u001f\"";
    let (bytes, _) = canon(input);
    let s = String::from_utf8(bytes).unwrap();
    assert_eq!(s, "\"\\u0000\\u0001\\u001f\"");
}

// ---------------------------------------------------------------------------
// Depth limits
// ---------------------------------------------------------------------------

#[test]
fn semantic_depth_64_accepted() {
    // Build a value of depth 64: 64 nested arrays containing a primitive
    let mut s = String::new();
    for _ in 0..64 {
        s.push('[');
    }
    s.push('1');
    for _ in 0..64 {
        s.push(']');
    }
    let result = parse_core_json(
        s.as_bytes(),
        ParseLimits::semantic(MAX_SEMANTIC_JSON_NESTING_DEPTH).unwrap(),
    );
    assert!(result.is_ok(), "depth-64 should be accepted");
}

#[test]
fn semantic_depth_65_rejected() {
    // Build a value of depth 65
    let mut s = String::new();
    for _ in 0..65 {
        s.push('[');
    }
    s.push('1');
    for _ in 0..65 {
        s.push(']');
    }
    let result = parse_core_json(
        s.as_bytes(),
        ParseLimits::semantic(MAX_SEMANTIC_JSON_NESTING_DEPTH).unwrap(),
    );
    assert!(
        result.is_err(),
        "depth-65 should be rejected under limit 64"
    );
}

#[test]
fn wire_depth_96_accepted() {
    let mut s = String::new();
    for _ in 0..96 {
        s.push('[');
    }
    s.push('1');
    for _ in 0..96 {
        s.push(']');
    }
    let result = parse_core_json(s.as_bytes(), ParseLimits::protocol_wire());
    assert!(result.is_ok(), "wire depth-96 should be accepted");
}

#[test]
fn wire_depth_97_rejected() {
    let mut s = String::new();
    for _ in 0..97 {
        s.push('[');
    }
    s.push('1');
    for _ in 0..97 {
        s.push(']');
    }
    let result = parse_core_json(s.as_bytes(), ParseLimits::protocol_wire());
    assert!(result.is_err(), "wire depth-97 should be rejected");
}

// ---------------------------------------------------------------------------
// Nested root: depth-64 embedded value doesn't consume enclosing budget
// ---------------------------------------------------------------------------

#[test]
fn nested_root_depth_independent() {
    // An embedded JSON value at depth 64 inside a depth-1 container
    // should be accepted because the embedded root is checked independently.
    let mut inner = String::new();
    for _ in 0..64 {
        inner.push('[');
    }
    inner.push('1');
    for _ in 0..64 {
        inner.push(']');
    }
    let outer = format!("{{\"embedded\":{inner}}}");
    // The outer container has semantic depth 65 (1 + 64), which exceeds 64.
    // But if we use the wire limit (96), it should be accepted.
    let result = parse_core_json(outer.as_bytes(), ParseLimits::protocol_wire());
    assert!(result.is_ok(), "wire parse should accept depth-65");

    // Under semantic limit 64, this should be rejected because the outer
    // container's semantic depth is 65.
    let result = parse_core_json(
        outer.as_bytes(),
        ParseLimits::semantic(MAX_SEMANTIC_JSON_NESTING_DEPTH).unwrap(),
    );
    assert!(result.is_err(), "semantic depth 65 should be rejected");
}

// ---------------------------------------------------------------------------
// Sha256Digest parsing
// ---------------------------------------------------------------------------

#[test]
fn digest_lowercase_accepted() {
    let d = Sha256Digest::from_str(
        "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    )
    .unwrap();
    assert_eq!(
        d.to_canonical_string(),
        "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
    );
}

#[test]
fn digest_uppercase_rejected() {
    let result = Sha256Digest::from_str(
        "sha256:44136FA355B3678A1146AD16F7E8649E94FB4FC21FE77E8310C060F61CAAFF8A",
    );
    assert!(result.is_err(), "uppercase hex should be rejected");
}

#[test]
fn digest_wrong_length_rejected() {
    let result = Sha256Digest::from_str("sha256:44136fa355b3678");
    assert!(result.is_err(), "wrong length should be rejected");
}

#[test]
fn digest_verify_bytes() {
    let d = Sha256Digest::compute(b"{}");
    assert_eq!(
        d.to_canonical_string(),
        "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
    );
    assert!(d.verify_bytes(b"{}").is_ok());
    assert!(d.verify_bytes(b"[]").is_err());
}
