//! Domain scalar type tests: identifiers, numbers, timestamps, error envelopes,
//! and LeaseToken.

use dolly_core_domain::{
    ActionName, Attempt, CommitSeq, ConfigRevision, CoreErrorCode, CoreOutcome, CursorSpan,
    DeliveryKey, DescriptorRevision, ExtensionGeneration, ExtensionId, GraphRevision, InstanceId,
    LeaseGeneration, LeaseToken, ModuleId, PageId, PageSeq, SafeU53, Timestamp, UuidV7,
};
use std::str::FromStr;

// ---------------------------------------------------------------------------
// Local identifiers: InstanceId, PageId, ModuleId
// ---------------------------------------------------------------------------

#[test]
fn local_id_valid_boundaries() {
    assert!(InstanceId::from_str("a").is_ok());
    assert!(InstanceId::from_str("a1").is_ok());
    assert!(InstanceId::from_str("my-instance").is_ok());
    assert!(InstanceId::from_str("a-b-c-1-2").is_ok());
    // 63 bytes (max)
    let max63 = "a".repeat(63);
    assert!(InstanceId::from_str(&max63).is_ok());
}

#[test]
fn local_id_invalid() {
    assert!(InstanceId::from_str("").is_err()); // empty
    assert!(InstanceId::from_str("A").is_err()); // uppercase
    assert!(InstanceId::from_str("1abc").is_err()); // starts with digit
    assert!(InstanceId::from_str("a--b").is_err()); // double hyphen
    assert!(InstanceId::from_str("a-").is_err()); // trailing hyphen
    assert!(InstanceId::from_str("-a").is_err()); // leading hyphen
    assert!(InstanceId::from_str("a.b").is_err()); // dot not allowed
    assert!(InstanceId::from_str(&"a".repeat(64)).is_err()); // 64 bytes (too long)
    assert!(InstanceId::from_str("café").is_err()); // non-ASCII
}

#[test]
fn page_id_and_module_id_same_grammar() {
    assert!(PageId::from_str("page-1").is_ok());
    assert!(ModuleId::from_str("module-1").is_ok());
    assert!(PageId::from_str("A").is_err());
    assert!(ModuleId::from_str("").is_err());
}

// ---------------------------------------------------------------------------
// ExtensionId
// ---------------------------------------------------------------------------

#[test]
fn extension_id_valid() {
    assert!(ExtensionId::from_str("org.dolly.llm").is_ok());
    assert!(ExtensionId::from_str("org.dolly.memory").is_ok());
    assert!(ExtensionId::from_str("com.example.extension-1").is_ok());
}

#[test]
fn extension_id_invalid() {
    assert!(ExtensionId::from_str("org.dolly").is_err()); // only 2 labels
    assert!(ExtensionId::from_str("org").is_err()); // only 1 label
    assert!(ExtensionId::from_str("Org.dolly.llm").is_err()); // uppercase
    assert!(ExtensionId::from_str("org.dolly.llm.").is_err()); // trailing dot
}

// ---------------------------------------------------------------------------
// ActionName
// ---------------------------------------------------------------------------

#[test]
fn action_name_valid_for_owner() {
    let owner = ExtensionId::from_str("org.dolly.memory").unwrap();
    assert!(ActionName::parse_for_owner(&owner, "org.dolly.memory.search").is_ok());
    assert!(ActionName::parse_for_owner(&owner, "org.dolly.memory.search.recent").is_ok());
}

#[test]
fn action_name_prefix_confusion_rejected() {
    let owner = ExtensionId::from_str("org.dolly.memory").unwrap();
    // Wrong owner prefix
    assert!(ActionName::parse_for_owner(&owner, "org.dolly.llm.search").is_err());
    // No operation label
    assert!(ActionName::parse_for_owner(&owner, "org.dolly.memory").is_err());
    // Owner not at start
    assert!(ActionName::parse_for_owner(&owner, "xorg.dolly.memory.search").is_err());
}

#[test]
fn action_name_owner_extraction() {
    let owner = ExtensionId::from_str("org.dolly.memory").unwrap();
    let action = ActionName::parse_for_owner(&owner, "org.dolly.memory.search").unwrap();
    assert_eq!(action.owner().as_str(), "org.dolly.memory");
    assert_eq!(action.as_str(), "org.dolly.memory.search");
}

#[test]
fn action_name_preserves_owner_with_more_than_three_labels() {
    let owner = ExtensionId::from_str("org.example.deep.extension").unwrap();
    let action = ActionName::parse_for_owner(&owner, "org.example.deep.extension.search").unwrap();
    assert_eq!(action.owner(), owner);
}

#[test]
fn action_name_owner_free_deserialization_is_rejected() {
    let deserializer = serde::de::value::StrDeserializer::<serde::de::value::Error>::new(
        "org.example.deep.extension.search",
    );
    let result = <ActionName as serde::Deserialize>::deserialize(deserializer);
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// UuidV7
// ---------------------------------------------------------------------------

#[test]
fn uuid_v7_valid() {
    assert!(UuidV7::from_str("01891b5a-4d8e-7abc-9def-0123456789ab").is_ok());
    assert!(UuidV7::from_str("01891b5a-4d8e-7abc-a123-0123456789ab").is_ok());
    assert!(UuidV7::from_str("01891b5a-4d8e-7abc-b123-0123456789ab").is_ok());
}

#[test]
fn uuid_v7_invalid() {
    // Uppercase
    assert!(UuidV7::from_str("01891B5A-4D8E-7ABC-9DEF-0123456789AB").is_err());
    // Wrong version nibble (not 7)
    assert!(UuidV7::from_str("01891b5a-4d8e-8abc-9def-0123456789ab").is_err());
    // Wrong variant nibble
    assert!(UuidV7::from_str("01891b5a-4d8e-7abc-cdef-0123456789ab").is_err());
    assert!(UuidV7::from_str("01891b5a-4d8e-7abc-0def-0123456789ab").is_err());
    // Wrong length
    assert!(UuidV7::from_str("01891b5a-4d8e-7abc-9def-0123456789").is_err());
}

#[test]
fn uuid_v7_variant_nibbles() {
    // Each valid variant nibble: 8, 9, a, b
    for variant in &["8", "9", "a", "b"] {
        let s = format!("01891b5a-4d8e-7abc-{}def-0123456789ab", variant);
        assert!(
            UuidV7::from_str(&s).is_ok(),
            "variant {variant} should be valid"
        );
    }
    // Invalid variant nibbles: 0-7, c-f
    for variant in &["0", "1", "7", "c", "d", "e", "f"] {
        let s = format!("01891b5a-4d8e-7abc-{}def-0123456789ab", variant);
        assert!(
            UuidV7::from_str(&s).is_err(),
            "variant {variant} should be invalid"
        );
    }
}

// ---------------------------------------------------------------------------
// SafeU53
// ---------------------------------------------------------------------------

#[test]
fn safe_u53_boundaries() {
    assert!(SafeU53::new(0).is_ok());
    assert!(SafeU53::new(9007199254740991).is_ok()); // 2^53 - 1
    assert!(SafeU53::new(9007199254740992).is_err()); // 2^53
}

// ---------------------------------------------------------------------------
// Positive assigned sequences/revisions
// ---------------------------------------------------------------------------

#[test]
fn positive_sequences_reject_zero() {
    assert!(CommitSeq::new(0).is_err());
    assert!(PageSeq::new(0).is_err());
    assert!(GraphRevision::new(0).is_err());
    assert!(ConfigRevision::new(0).is_err());
    assert!(DescriptorRevision::new(0).is_err());
    assert!(LeaseGeneration::new(0).is_err());
    assert!(ExtensionGeneration::new(0).is_err());
}

#[test]
fn positive_sequences_accept_one() {
    assert!(CommitSeq::new(1).is_ok());
    assert!(PageSeq::new(1).is_ok());
    assert!(GraphRevision::new(1).is_ok());
    assert!(ConfigRevision::new(1).is_ok());
}

#[test]
fn checked_next_does_not_wrap() {
    let max = SafeU53::new(SafeU53::MAX).unwrap();
    assert!(max.checked_next().is_err());

    let seq = CommitSeq::new(1).unwrap();
    let next = seq.checked_next().unwrap();
    assert_eq!(next.value(), 2);
}

#[test]
fn attempt_allows_zero() {
    assert!(Attempt::new(0).is_ok());
    assert!(Attempt::new(1).is_ok());
}

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------

#[test]
fn timestamp_valid() {
    assert!(Timestamp::from_str("2026-07-24T12:00:00.000000Z").is_ok());
    assert!(Timestamp::from_str("2026-02-28T23:59:59.999999Z").is_ok());
}

#[test]
fn timestamp_leap_year() {
    // 2024 is a leap year
    assert!(Timestamp::from_str("2024-02-29T00:00:00.000000Z").is_ok());
    // 2025 is not
    assert!(Timestamp::from_str("2025-02-29T00:00:00.000000Z").is_err());
}

#[test]
fn timestamp_impossible_date() {
    assert!(Timestamp::from_str("2026-02-30T00:00:00.000000Z").is_err());
    assert!(Timestamp::from_str("2026-04-31T00:00:00.000000Z").is_err());
    assert!(Timestamp::from_str("2026-13-01T00:00:00.000000Z").is_err());
}

#[test]
fn timestamp_leap_second_rejected() {
    assert!(Timestamp::from_str("2026-07-24T23:59:60.000000Z").is_err());
}

#[test]
fn timestamp_offset_rejected() {
    assert!(Timestamp::from_str("2026-07-24T12:00:00.000000+00:00").is_err());
}

#[test]
fn timestamp_lowercase_z_rejected() {
    assert!(Timestamp::from_str("2026-07-24T12:00:00.000000z").is_err());
}

#[test]
fn timestamp_wrong_fractional_digits() {
    assert!(Timestamp::from_str("2026-07-24T12:00:00.000Z").is_err()); // 3 digits
    assert!(Timestamp::from_str("2026-07-24T12:00:00.0000000Z").is_err()); // 7 digits
}

// ---------------------------------------------------------------------------
// LeaseToken
// ---------------------------------------------------------------------------

#[test]
fn lease_token_valid() {
    // 32 bytes encoded as base64url = 43 characters
    // Use a known-valid 43-char base64url string
    let token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    // This is 43 'A's, which decodes to 32 zero bytes
    assert!(LeaseToken::from_str(token).is_ok());
}

#[test]
fn lease_token_debug_redacted() {
    let token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let lt = LeaseToken::from_str(token).unwrap();
    let debug = format!("{lt:?}");
    assert!(debug.contains("redacted"));
    assert!(!debug.contains("AAAA"));
}

#[test]
fn lease_token_noncanonical_rejected() {
    // 44 characters (padded) should be rejected
    assert!(LeaseToken::from_str("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=").is_err());
    // 42 characters (too short) should be rejected
    assert!(LeaseToken::from_str("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").is_err());
}

// ---------------------------------------------------------------------------
// CoreErrorCode
// ---------------------------------------------------------------------------

#[test]
fn core_error_code_valid() {
    assert!(CoreErrorCode::from_str("CORE_INVALID_JSON").is_ok());
    assert!(CoreErrorCode::from_str("CORE_INVALID_ID").is_ok());
    assert!(CoreErrorCode::from_str("CORE_FORGED_IDENTITY").is_ok());
    assert!(CoreErrorCode::from_str("CORE_ID_COLLISION").is_ok());
    assert!(CoreErrorCode::from_str("CORE_DIGEST_MISMATCH").is_ok());
    assert!(CoreErrorCode::from_str("CORE_SEQUENCE_EXHAUSTED").is_ok());
    assert!(CoreErrorCode::from_str("CORE_QUOTA_EXCEEDED").is_ok());
}

#[test]
fn core_error_code_invalid() {
    assert!(CoreErrorCode::from_str("core_invalid_json").is_err()); // lowercase
    assert!(CoreErrorCode::from_str("CORE-invalid").is_err()); // hyphens not allowed
    assert!(CoreErrorCode::from_str("").is_err()); // empty
    assert!(CoreErrorCode::from_str("A").is_err()); // too short (pattern requires [A-Z][A-Z0-9_]+, i.e. at least 2 chars)
}

#[test]
fn core_error_code_associated_constants() {
    assert_eq!(CoreErrorCode::CORE_INVALID_JSON, "CORE_INVALID_JSON");
    assert_eq!(CoreErrorCode::CORE_INVALID_ID, "CORE_INVALID_ID");
    assert_eq!(CoreErrorCode::CORE_FORGED_IDENTITY, "CORE_FORGED_IDENTITY");
    assert_eq!(CoreErrorCode::CORE_ID_COLLISION, "CORE_ID_COLLISION");
    assert_eq!(CoreErrorCode::CORE_DIGEST_MISMATCH, "CORE_DIGEST_MISMATCH");
    assert_eq!(
        CoreErrorCode::CORE_SEQUENCE_EXHAUSTED,
        "CORE_SEQUENCE_EXHAUSTED"
    );
    assert_eq!(CoreErrorCode::CORE_QUOTA_EXCEEDED, "CORE_QUOTA_EXCEEDED");
}

// ---------------------------------------------------------------------------
// CoreOutcome
// ---------------------------------------------------------------------------

#[test]
fn core_outcome_serialization() {
    assert_eq!(CoreOutcome::NotApplied.as_str(), "not_applied");
    assert_eq!(CoreOutcome::Applied.as_str(), "applied");
    assert_eq!(CoreOutcome::Unknown.as_str(), "unknown");
}

// ---------------------------------------------------------------------------
// DeliveryKey and CursorSpan
// ---------------------------------------------------------------------------

#[test]
fn delivery_key_construction() {
    let dk = DeliveryKey {
        page_id: PageId::from_str("page-1").unwrap(),
        page_seq: PageSeq::new(42).unwrap(),
    };
    assert_eq!(dk.page_id.as_str(), "page-1");
    assert_eq!(dk.page_seq.value(), 42);
}

#[test]
fn cursor_span_construction() {
    let cs = CursorSpan {
        page_id: PageId::from_str("page-1").unwrap(),
        from_inclusive: PageSeq::new(1).unwrap(),
        to_exclusive: PageSeq::new(10).unwrap(),
    };
    assert_eq!(cs.from_inclusive.value(), 1);
    assert_eq!(cs.to_exclusive.value(), 10);
}
