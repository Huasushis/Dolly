//! `ParseLimits` constructor and depth-enforcement boundary tests.
//!
//! These tests pin the `ParseLimits::new` upper bound at
//! `PROTOCOL_WIRE_PARSE_DEPTH` (96) and guard the existing `semantic` and
//! `protocol_wire` constructors against regression. They also exercise the
//! recursive parser against deeply nested JSON at the exact boundary.

use dolly_canonical_json::{
    MAX_SEMANTIC_JSON_NESTING_DEPTH, PROTOCOL_WIRE_PARSE_DEPTH, ParseLimits, parse_core_json,
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
