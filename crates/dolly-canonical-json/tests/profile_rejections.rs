//! Core JSON profile rejection tests.
//!
//! Each test verifies that a specific profile violation is rejected with
//! `CORE_INVALID_JSON` before producing canonical bytes.

use dolly_canonical_json::{CanonicalError, CanonicalErrorCode, ParseLimits, parse_core_json};

fn reject(input: &[u8]) -> CanonicalError {
    parse_core_json(input, ParseLimits::protocol_wire()).unwrap_err()
}

fn assert_invalid_json(input: &[u8]) {
    let err = reject(input);
    assert_eq!(
        err.code,
        CanonicalErrorCode::CoreInvalidJson,
        "expected CORE_INVALID_JSON for input {:?}, got: {}",
        std::str::from_utf8(input).unwrap_or("<invalid utf-8>"),
        err
    );
}

// ---------------------------------------------------------------------------
// BOM rejection
// ---------------------------------------------------------------------------

#[test]
fn reject_utf8_bom() {
    assert_invalid_json(b"\xEF\xBB\xBF{}");
}

// ---------------------------------------------------------------------------
// Invalid UTF-8 rejection
// ---------------------------------------------------------------------------

#[test]
fn reject_invalid_utf8() {
    assert_invalid_json(b"{\"key\":\"\xFF\xFE\"}");
}

// ---------------------------------------------------------------------------
// Lone surrogate rejections
// ---------------------------------------------------------------------------

#[test]
fn reject_escaped_lone_high_surrogate() {
    assert_invalid_json(b"\"\\uD800\"");
}

#[test]
fn reject_escaped_lone_low_surrogate() {
    assert_invalid_json(b"\"\\uDC00\"");
}

#[test]
fn reject_surrogate_pair_with_invalid_low() {
    // High surrogate followed by non-low-surrogate
    assert_invalid_json(b"\"\\uD800\\u0041\"");
}

// ---------------------------------------------------------------------------
// Duplicate object member rejection
// ---------------------------------------------------------------------------

#[test]
fn reject_duplicate_member() {
    assert_invalid_json(b"{\"a\":1,\"a\":2}");
}

#[test]
fn reject_duplicate_member_nested() {
    assert_invalid_json(b"{\"outer\":{\"inner\":1,\"inner\":2}}");
}

// ---------------------------------------------------------------------------
// Non-finite number rejection
// ---------------------------------------------------------------------------

#[test]
fn reject_overflow_to_non_finite() {
    // 1e400 overflows f64 to infinity
    assert_invalid_json(b"1e400");
}

// ---------------------------------------------------------------------------
// Negative zero rejection
// ---------------------------------------------------------------------------

#[test]
fn reject_negative_zero() {
    assert_invalid_json(b"-0");
}

#[test]
fn reject_negative_zero_float() {
    assert_invalid_json(b"-0.0");
}

// ---------------------------------------------------------------------------
// Depth limit rejection
// ---------------------------------------------------------------------------

#[test]
fn reject_semantic_depth_65_under_limit_64() {
    let mut s = String::new();
    for _ in 0..65 {
        s.push('[');
    }
    s.push('1');
    for _ in 0..65 {
        s.push(']');
    }
    let err = parse_core_json(s.as_bytes(), ParseLimits::semantic(64).unwrap()).unwrap_err();
    assert_eq!(err.code, CanonicalErrorCode::CoreInvalidJson);
}

fn nested_containers(depth: usize, terminal: &str) -> String {
    assert!(depth > 0);
    let wrappers = depth - 1;
    format!("{}{terminal}{}", "[".repeat(wrappers), "]".repeat(wrappers))
}

#[test]
fn empty_terminal_containers_count_at_depth_boundary() {
    let limits = ParseLimits::semantic(64).unwrap();
    for terminal in ["{}", "[]"] {
        assert!(parse_core_json(nested_containers(64, terminal).as_bytes(), limits).is_ok());
        let error =
            parse_core_json(nested_containers(65, terminal).as_bytes(), limits).unwrap_err();
        assert_eq!(error.code, CanonicalErrorCode::CoreInvalidJson);
    }
}

// ---------------------------------------------------------------------------
// Trailing data rejection
// ---------------------------------------------------------------------------

#[test]
fn reject_trailing_data() {
    assert_invalid_json(b"{} garbage");
}

// ---------------------------------------------------------------------------
// Unescaped control character rejection
// ---------------------------------------------------------------------------

#[test]
fn reject_unescaped_control_char_in_string() {
    assert_invalid_json(b"{\"key\":\"value\x01with control\"}");
}

// ---------------------------------------------------------------------------
// Invalid JSON tokens
// ---------------------------------------------------------------------------

#[test]
fn reject_empty_input() {
    assert_invalid_json(b"");
}

#[test]
fn reject_just_whitespace() {
    assert_invalid_json(b"   ");
}

#[test]
fn reject_unterminated_string() {
    assert_invalid_json(b"\"unterminated");
}

#[test]
fn reject_single_digit_after_decimal() {
    assert_invalid_json(b"1.");
}

#[test]
fn reject_leading_zero() {
    assert_invalid_json(b"01");
}

#[test]
fn reject_trailing_comma_in_array() {
    assert_invalid_json(b"[1,2,]");
}

#[test]
fn reject_trailing_comma_in_object() {
    assert_invalid_json(b"{\"a\":1,}");
}
