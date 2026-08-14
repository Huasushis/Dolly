//! Shared validation helpers used by identifier types.
//!
//! The patterns used by Dolly identifiers are fixed and simple enough for
//! direct hand-rolled validation rather than a regex crate, keeping
//! `dolly-core-domain` free of any dependency beyond `serde` and
//! `dolly-canonical-json`.

/// Validate a local identifier: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`.
///
/// First character must be `a-z`; subsequent characters are `a-z0-9` in
/// hyphen-separated groups of at least one character each.
pub(crate) fn is_valid_local_id(s: &str) -> bool {
    let mut chars = s.chars().peekable();
    // First char must be a-z
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    // Remaining: groups of [a-z0-9]+ separated by single hyphens
    let mut after_hyphen = false;
    for c in chars {
        if c == '-' {
            if after_hyphen {
                return false; // double hyphen
            }
            after_hyphen = true;
        } else if c.is_ascii_lowercase() || c.is_ascii_digit() {
            after_hyphen = false;
        } else {
            return false; // invalid character
        }
    }
    !after_hyphen // no trailing hyphen
}

/// Validate an ExtensionId: reverse-DNS with at least three labels.
/// `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){2,}$`
pub(crate) fn is_valid_extension_id(s: &str) -> bool {
    let labels: Vec<&str> = s.split('.').collect();
    if labels.len() < 3 {
        return false;
    }
    for label in &labels {
        if !is_valid_label(label) {
            return false;
        }
    }
    true
}

/// Validate a QualifiedName: reverse-DNS with at least two labels.
/// `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$`
pub(crate) fn is_valid_qualified_name(s: &str) -> bool {
    let labels: Vec<&str> = s.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    for label in &labels {
        if !is_valid_label(label) {
            return false;
        }
    }
    true
}

/// Validate an ActionName grammar: reverse-DNS with at least four labels
/// (three owner + one operation).
/// `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){3,}$`
pub(crate) fn is_valid_action_name(s: &str) -> bool {
    let labels: Vec<&str> = s.split('.').collect();
    if labels.len() < 4 {
        return false;
    }
    for label in &labels {
        if !is_valid_label(label) {
            return false;
        }
    }
    true
}

/// A label matches `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`.
fn is_valid_label(s: &str) -> bool {
    is_valid_local_id(s)
}

/// Validate a UUIDv7: `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
pub(crate) fn is_valid_uuid_v7(s: &str) -> bool {
    if s.len() != 36 {
        return false;
    }
    let b = s.as_bytes();
    // Check hyphens at positions 8, 13, 18, 23
    if b[8] != b'-' || b[13] != b'-' || b[18] != b'-' || b[23] != b'-' {
        return false;
    }
    // Check hex at all other positions
    for (i, &c) in b.iter().enumerate() {
        if i == 8 || i == 13 || i == 18 || i == 23 {
            continue;
        }
        if !c.is_ascii_hexdigit() {
            return false;
        }
        // Must be lowercase
        if (b'A'..=b'F').contains(&c) {
            return false;
        }
    }
    // Version nibble at position 14 must be '7'
    if b[14] != b'7' {
        return false;
    }
    // Variant nibble at position 19 must be 8, 9, a, or b
    if !matches!(b[19], b'8' | b'9' | b'a' | b'b') {
        return false;
    }
    true
}

/// Match a named pattern. This dispatches to the specific validator for each
/// known pattern. It is not a general regex engine.
pub(crate) fn match_pattern(pattern: &str, text: &str) -> bool {
    // Dispatch based on known patterns
    match pattern {
        r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" => is_valid_local_id(text),
        r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){2,}$" => {
            is_valid_extension_id(text)
        }
        r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$" => {
            is_valid_qualified_name(text)
        }
        r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){3,}$" => {
            is_valid_action_name(text)
        }
        r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" => {
            is_valid_uuid_v7(text)
        }
        _ => {
            // For unknown patterns, try a simple approach: use serde_json to
            // validate. This should not happen in practice.
            false
        }
    }
}
