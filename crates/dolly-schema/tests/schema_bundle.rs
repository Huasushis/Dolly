//! Schema bundle validator tests: verify that the bundle validator resolves
//! cross-`$ref` by `$id`, that validation works for valid/invalid instances,
//! and that unknown members are rejected.

use dolly_canonical_json::{CanonicalJsonValue, ParseLimits, parse_core_json};
use dolly_schema::{
    ACTIVATION_MANIFEST_SCHEMA_ID, BLOCK_SCHEMA_ID, ERROR_SCHEMA_ID, MODULE_DESCRIPTOR_SCHEMA_ID,
    embedded_schema_catalog,
};

fn parse(input: &str) -> CanonicalJsonValue {
    parse_core_json(input.as_bytes(), ParseLimits::protocol_wire()).unwrap()
}

// ---------------------------------------------------------------------------
// Valid error envelope validation
// ---------------------------------------------------------------------------

#[test]
fn validate_valid_error_envelope() {
    let catalog = embedded_schema_catalog().unwrap();
    let instance = parse(
        r#"{
            "code": "CORE_INVALID_ID",
            "retryable": false,
            "outcome": "not_applied",
            "message": "invalid identifier",
            "details": {}
        }"#,
    );
    let result = catalog.validate(ERROR_SCHEMA_ID, &instance, 64);
    assert!(
        result.is_ok(),
        "valid error envelope should pass: {:?}",
        result.err()
    );
}

// ---------------------------------------------------------------------------
// Invalid: unknown member in error envelope
// ---------------------------------------------------------------------------

#[test]
fn validate_unknown_member_rejected() {
    let catalog = embedded_schema_catalog().unwrap();
    let instance = parse(
        r#"{
            "code": "CORE_INVALID_ID",
            "retryable": false,
            "outcome": "not_applied",
            "message": "invalid identifier",
            "details": {},
            "unknown_field": true
        }"#,
    );
    let result = catalog.validate(ERROR_SCHEMA_ID, &instance, 64);
    assert!(result.is_err(), "unknown member should be rejected");
    let errors = result.unwrap_err();
    assert!(!errors.is_empty(), "should have validation errors");
}

// ---------------------------------------------------------------------------
// Cross-$ref resolution by $id
// ---------------------------------------------------------------------------

#[test]
fn cross_ref_resolution_by_id() {
    let catalog = embedded_schema_catalog().unwrap();

    // The module-descriptor schema references common.schema.json via $ref.
    // If the validator can build, it means cross-$ref resolution is working.
    let validator = catalog.validator(MODULE_DESCRIPTOR_SCHEMA_ID);
    assert!(
        validator.is_ok(),
        "validator should build with cross-$ref resolution"
    );
}

// ---------------------------------------------------------------------------
// Activation manifest schema validation
// ---------------------------------------------------------------------------

#[test]
fn activation_manifest_validator_builds() {
    let catalog = embedded_schema_catalog().unwrap();
    let validator = catalog.validator(ACTIVATION_MANIFEST_SCHEMA_ID);
    assert!(
        validator.is_ok(),
        "activation-manifest validator should build"
    );
}

// ---------------------------------------------------------------------------
// Block schema validation
// ---------------------------------------------------------------------------

#[test]
fn block_validator_builds() {
    let catalog = embedded_schema_catalog().unwrap();
    let validator = catalog.validator(BLOCK_SCHEMA_ID);
    assert!(validator.is_ok(), "block validator should build");
}

// ---------------------------------------------------------------------------
// Validation errors expose instance path and schema path
// ---------------------------------------------------------------------------

#[test]
fn validation_errors_expose_paths() {
    let catalog = embedded_schema_catalog().unwrap();
    // An error envelope with wrong type for "retryable" (should be bool)
    let instance = parse(
        r#"{
            "code": "CORE_INVALID_ID",
            "retryable": "yes",
            "outcome": "not_applied",
            "message": "invalid identifier",
            "details": {}
        }"#,
    );
    let result = catalog.validate(ERROR_SCHEMA_ID, &instance, 64);
    assert!(result.is_err());
    let errors = result.unwrap_err();
    let issues = errors.issues();
    assert!(!issues.is_empty());
    // At least one error should mention "retryable" in the instance path
    let has_retryable_error = issues
        .iter()
        .any(|i| i.instance_path.contains("retryable") || i.message.contains("retryable"));
    assert!(
        has_retryable_error,
        "expected an error mentioning 'retryable', got: {:?}",
        issues
    );
}

// ---------------------------------------------------------------------------
// validate_bytes: parse + validate + deserialize
// ---------------------------------------------------------------------------

#[test]
fn validate_bytes_valid_error_envelope() {
    let catalog = embedded_schema_catalog().unwrap();
    let input = br#"{
            "code": "CORE_INVALID_ID",
            "retryable": false,
            "outcome": "not_applied",
            "message": "invalid identifier",
            "details": {}
        }"#;
    let result: Result<dolly_canonical_json::CanonicalJsonValue, _> =
        catalog.validate_bytes(ERROR_SCHEMA_ID, input, ParseLimits::protocol_wire(), 64);
    assert!(
        result.is_ok(),
        "valid error envelope should pass validate_bytes"
    );
}

#[test]
fn validate_bytes_rejects_duplicate_keys() {
    let catalog = embedded_schema_catalog().unwrap();
    let input = br#"{
            "code": "CORE_INVALID_ID",
            "code": "CORE_INVALID_ID",
            "retryable": false,
            "outcome": "not_applied",
            "message": "invalid identifier",
            "details": {}
        }"#;
    let result: Result<dolly_canonical_json::CanonicalJsonValue, _> =
        catalog.validate_bytes(ERROR_SCHEMA_ID, input, ParseLimits::protocol_wire(), 64);
    assert!(
        result.is_err(),
        "duplicate keys should fail before schema validation"
    );
}

fn error_envelope_with_details_depth(details_depth: usize) -> String {
    assert!(details_depth > 0);
    let wrappers = details_depth - 1;
    let details = format!(
        "{}{{}}{}",
        r#"{"nested":"#.repeat(wrappers),
        "}".repeat(wrappers)
    );
    format!(
        r#"{{"code":"CORE_INVALID_ID","retryable":false,"outcome":"not_applied","message":"invalid identifier","details":{details}}}"#
    )
}

#[test]
fn semantic_depth_is_enforced_at_schema_roots() {
    let catalog = embedded_schema_catalog().unwrap();
    let depth_64 = error_envelope_with_details_depth(63);
    let depth_65 = error_envelope_with_details_depth(64);

    let valid = parse_core_json(depth_64.as_bytes(), ParseLimits::protocol_wire()).unwrap();
    assert!(catalog.validate(ERROR_SCHEMA_ID, &valid, 64).is_ok());

    let invalid = parse_core_json(depth_65.as_bytes(), ParseLimits::protocol_wire()).unwrap();
    assert!(catalog.validate(ERROR_SCHEMA_ID, &invalid, 64).is_err());

    let result: Result<CanonicalJsonValue, _> = catalog.validate_bytes(
        ERROR_SCHEMA_ID,
        depth_65.as_bytes(),
        ParseLimits::protocol_wire(),
        64,
    );
    assert!(result.is_err());

    assert!(catalog.validate(ERROR_SCHEMA_ID, &valid, 65).is_err());
    let invalid_limit: Result<CanonicalJsonValue, _> = catalog.validate_bytes(
        ERROR_SCHEMA_ID,
        depth_64.as_bytes(),
        ParseLimits::protocol_wire(),
        65,
    );
    assert!(invalid_limit.is_err());
}
