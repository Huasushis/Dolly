//! `ParseLimits` constructor and depth-enforcement boundary tests.
//!
//! These tests pin the `ParseLimits::new` upper bound at
//! `PROTOCOL_WIRE_PARSE_DEPTH` (96) and guard the existing `semantic` and
//! `protocol_wire` constructors against regression. They also exercise the
//! recursive parser against deeply nested JSON at the exact boundary.

use dolly_canonical_json::{
    MAX_SEMANTIC_JSON_NESTING_DEPTH, PROTOCOL_WIRE_PARSE_DEPTH, ParseLimits, parse_core_json,
    validate_raw_json_nesting_depth,
};

/// Build deeply nested JSON of the given depth: `depth` open `[`, a `1`,
/// then `depth` close `]`.
fn nested_json(depth: usize) -> String {
    let mut s = String::with_capacity(depth * 2 + 1);
    for _ in 0..depth {
        s.push('[');
    }
    s.push('1');
    for _ in 0..depth {
        s.push(']');
    }
    s
}

// ---------------------------------------------------------------------------
// ParseLimits::new boundary behavior
// ---------------------------------------------------------------------------

#[test]
fn new_zero_rejected() {
    assert!(ParseLimits::new(0).is_err(), "depth 0 must be rejected");
}

#[test]
fn new_one_accepted() {
    let limits = ParseLimits::new(1).expect("depth 1 should be accepted");
    assert_eq!(limits.max_nesting_depth(), 1);
}

#[test]
fn new_protocol_wire_boundary_accepted() {
    let limits = ParseLimits::new(PROTOCOL_WIRE_PARSE_DEPTH)
        .expect("depth == PROTOCOL_WIRE_PARSE_DEPTH should be accepted");
    assert_eq!(limits.max_nesting_depth(), PROTOCOL_WIRE_PARSE_DEPTH);
}

#[test]
fn new_just_above_boundary_rejected() {
    assert!(
        ParseLimits::new(PROTOCOL_WIRE_PARSE_DEPTH + 1).is_err(),
        "depth just above PROTOCOL_WIRE_PARSE_DEPTH must be rejected"
    );
}

#[test]
fn new_attack_depth_rejected() {
    // Attacker-supplied deeply nested JSON scenario: the maximum u16 value.
    assert!(
        ParseLimits::new(u16::MAX).is_err(),
        "max u16 depth must be rejected (stack-exhaust attack vector)"
    );
}

// ---------------------------------------------------------------------------
// ParseLimits::semantic regression guards
// ---------------------------------------------------------------------------

#[test]
fn semantic_at_ceiling_accepted() {
    let limits =
        ParseLimits::semantic(MAX_SEMANTIC_JSON_NESTING_DEPTH).expect("semantic(64) accepted");
    assert_eq!(limits.max_nesting_depth(), MAX_SEMANTIC_JSON_NESTING_DEPTH);
}

#[test]
fn semantic_above_ceiling_rejected() {
    assert!(
        ParseLimits::semantic(MAX_SEMANTIC_JSON_NESTING_DEPTH + 1).is_err(),
        "semantic(65) must be rejected"
    );
}

// ---------------------------------------------------------------------------
// ParseLimits::protocol_wire regression guard
// ---------------------------------------------------------------------------

#[test]
fn protocol_wire_is_96() {
    let limits = ParseLimits::protocol_wire();
    assert_eq!(limits.max_nesting_depth(), PROTOCOL_WIRE_PARSE_DEPTH);
}

// ---------------------------------------------------------------------------
// Recursive parser boundary with protocol_wire limits
// ---------------------------------------------------------------------------

#[test]
fn wire_depth_96_parses() {
    let s = nested_json(96);
    let result = parse_core_json(s.as_bytes(), ParseLimits::protocol_wire());
    assert!(
        result.is_ok(),
        "depth-96 JSON should parse under protocol_wire limit"
    );
}

#[test]
fn wire_depth_97_rejected() {
    let s = nested_json(97);
    let result = parse_core_json(s.as_bytes(), ParseLimits::protocol_wire());
    assert!(
        result.is_err(),
        "depth-97 JSON should be rejected under protocol_wire limit"
    );
}

// ---------------------------------------------------------------------------
// Raw-byte preparse nesting gate (no allocation, no recursion)
// ---------------------------------------------------------------------------

#[test]
fn raw_gate_accepts_exact_wire_ceiling() {
    validate_raw_json_nesting_depth(nested_json(96).as_bytes(), PROTOCOL_WIRE_PARSE_DEPTH)
        .expect("96 nesting levels sit exactly at the wire ceiling");
}

#[test]
fn raw_gate_refuses_one_above_wire_ceiling() {
    let error =
        validate_raw_json_nesting_depth(nested_json(97).as_bytes(), PROTOCOL_WIRE_PARSE_DEPTH)
            .expect_err("97 levels must be refused by the raw byte scan");
    assert!(error.to_string().contains("96-level"), "got: {error}");
}

#[test]
fn raw_gate_ignores_strings_and_escapes() {
    // A string full of brackets, quoted braces, and escaped quotes must not
    // disturb the depth count; the only structural container is the object.
    let payload = br#"{"a":"[[[","b":"{\"}\\\"[","c":[]}"#;
    validate_raw_json_nesting_depth(payload, 2).expect("strings do not contribute depth");
    // And an escaped quote inside a string must not terminate the string.
    validate_raw_json_nesting_depth(br#"["\"]"]"#, 1).expect("escaped quote stays inside string");
}

#[test]
fn raw_gate_rejects_trailing_non_whitespace() {
    let error = validate_raw_json_nesting_depth(b"{} garbage", 1).expect_err("trailing data");
    assert!(error.to_string().contains("trailing data"), "got: {error}");
}

#[test]
fn raw_gate_rejects_unbalanced_and_unterminated() {
    assert!(validate_raw_json_nesting_depth(b"[[}", 4).is_err(), "unbalanced must refuse");
    assert!(
        validate_raw_json_nesting_depth(br##"["open bad"##, 4).is_err(),
        "unclosed string must refuse"
    );
}

#[test]
fn raw_gate_zero_limit_rejected() {
    assert!(
        validate_raw_json_nesting_depth(b"{}", 0).is_err(),
        "max_depth 0 must be rejected up front"
    );
}
