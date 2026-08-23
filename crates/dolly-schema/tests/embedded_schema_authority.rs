//! Tests for the digest-gated embedded document validator.
//!
//! This file drives the public digest-gated entry point that compiles an
//! arbitrary complete, self-contained JSON Schema 2020-12 document after
//! verifying its exact SHA-256 digest. Every test computes the true digest of
//! its document first, so a failure caused by the reference policy or an
//! invalid document is not masked by a digest mismatch.

use dolly_canonical_json::{parse_core_json, CanonicalJsonValue, ParseLimits, Sha256Digest};
use dolly_schema::{SchemaError, SchemaValidator};

/// Parse a JSON document through the Core parser with the wire limit.
fn doc(json: &str) -> CanonicalJsonValue {
    parse_core_json(json.as_bytes(), ParseLimits::protocol_wire()).unwrap()
}

/// Compute the JCS SHA-256 digest of a canonical value.
fn digest_of(value: &CanonicalJsonValue) -> Sha256Digest {
    dolly_canonical_json::canonicalize(value).unwrap().1
}

/// Describe a result without requiring `SchemaValidator: Debug`.
fn describe(result: Result<SchemaValidator, SchemaError>) -> String {
    match result {
        Ok(_) => "compiled unexpectedly".to_string(),
        Err(e) => format!("{e:?}"),
    }
}

// --- 1. exact digest + object schema -------------------------------
#[test]
fn object_schema_with_exact_digest_validates_matching_and_rejects_mismatch() {
    let schema = doc(r##"{"type":"object","properties":{"a":{"type":"number"}},"required":["a"]}"##);
    let digest = digest_of(&schema);
    let validator = SchemaValidator::compile_embedded(&schema, &digest)
        .expect("object schema with exact digest compiles");
    assert!(validator.validate(&doc(r##"{"a":1}"##)).is_ok());
    assert!(validator.validate(&doc(r##"{"a":"x"}"##)).is_err());
    assert!(validator.validate(&doc(r##"{}"##)).is_err());
}

// --- 2. digest mismatch fails before compilation/validation ---------
#[test]
fn digest_mismatch_fails_before_compilation_or_validation() {
    // A deliberately non-compilable document (remote ref) plus the wrong
    // digest: the failure must be the digest, not the reference policy or a
    // schema build error, proving the order of the authority checks.
    let schema = doc(r##"{"$ref":"https://example.com/schema.json"}"##);
    let wrong_digest = digest_of(&doc(r##"{"type":"string"}"##));
    match SchemaValidator::compile_embedded(&schema, &wrong_digest) {
        Err(SchemaError::Digest(_)) => {}
        other => panic!("expected digest mismatch before any schema work: {}", describe(other)),
    }
}

// --- 3. boolean true/false schemas ----------------------------------
#[test]
fn boolean_true_schema_accepts_any_value() {
    let schema = CanonicalJsonValue::Bool(true);
    let digest = digest_of(&schema);
    let validator =
        SchemaValidator::compile_embedded(&schema, &digest).expect("true schema compiles");
    assert!(validator.validate(&doc(r##"{"anything":1}"##)).is_ok());
    assert!(validator.validate(&CanonicalJsonValue::Null).is_ok());
}

#[test]
fn boolean_false_schema_rejects_every_value() {
    let schema = CanonicalJsonValue::Bool(false);
    let digest = digest_of(&schema);
    let validator =
        SchemaValidator::compile_embedded(&schema, &digest).expect("false schema compiles");
    assert!(validator.validate(&doc(r##"{"anything":1}"##)).is_err());
    assert!(validator.validate(&CanonicalJsonValue::Null).is_err());
}

// --- 4. local RFC 6901 fragment works ---------------------------------
#[test]
fn local_rfc6901_fragment_defs_reference_works() {
    let schema = doc(
        r##"{"type":"object","properties":{"s":{"$ref":"#/$defs/greeting"}},"$defs":{"greeting":{"type":"string","pattern":"^hi"}}}"##,
    );
    let digest = digest_of(&schema);
    let validator = SchemaValidator::compile_embedded(&schema, &digest)
        .expect("schema with local $defs ref compiles");
    assert!(validator.validate(&doc(r##"{"s":"hibye"}"##)).is_ok());
    assert!(validator.validate(&doc(r##"{"s":"nope"}"##)).is_err());
    assert!(validator.validate(&doc(r##"{"s":5}"##)).is_err());
}

// --- 5. forbidden references rejected ----------------------------------
#[test]
fn remote_file_package_and_cross_document_refs_rejected() {
    let bad_refs = [
        r##"{"$ref":"https://example.com/schema.json"}"##,
        r##"{"$ref":"file:///etc/passwd.json"}"##,
        r##"{"$ref":"package:my-package/schema.json"}"##,
        r##"{"$ref":"other.json#/$defs/x"}"##,
        r##"{"$dynamicRef":"https://example.com/dyn.json"}"##,
    ];
    for bad in bad_refs {
        let schema = doc(bad);
        let digest = digest_of(&schema);
        match SchemaValidator::compile_embedded(&schema, &digest) {
            Err(SchemaError::Reference(_)) => {}
            other => panic!("expected reference rejection for {bad:?}: {}", describe(other)),
        }
    }
}

#[test]
fn named_and_dynamic_anchors_rejected() {
    // Named-anchor reference: a plain-name fragment is not `#` or `#/...`.
    let anchor = doc(r##"{"$ref":"#myanchor"}"##);
    let digest = digest_of(&anchor);
    match SchemaValidator::compile_embedded(&anchor, &digest) {
        Err(SchemaError::Reference(_)) => {}
        other => panic!("expected named-anchor reference rejection: {}", describe(other)),
    }

    // Dynamic-anchor reference.
    let dyn_anchor = doc(r##"{"$dynamicRef":"#mydynamic"}"##);
    let digest = digest_of(&dyn_anchor);
    match SchemaValidator::compile_embedded(&dyn_anchor, &digest) {
        Err(SchemaError::Reference(_)) => {}
        other => panic!("expected dynamic-anchor reference rejection: {}", describe(other)),
    }

    // Anchor declared in the document is still invalid: references to it are
    // forbidden, so the remaining surface is reject too, i.e. fail closed.
    let declares_anchor = doc(r##"{"$anchor":"x","type":"object"}"##);
    let digest = digest_of(&declares_anchor);
    match SchemaValidator::compile_embedded(&declares_anchor, &digest) {
        Err(SchemaError::Reference(_)) => {}
        other => panic!("expected anchor-declaration rejection: {}", describe(other)),
    }
}

// --- 6. null type validates null only ----------------------------------
#[test]
fn null_type_schema_validates_null_and_rejects_non_null() {
    let schema = doc(r##"{"type":"null"}"##);
    let digest = digest_of(&schema);
    let validator = SchemaValidator::compile_embedded(&schema, &digest)
        .expect("null schema compiles");
    // JSON null is a real, representable value here — preserving it is the
    // contract; absence is NOT represented by this API and must not be
    // synthesized (there is no Option, only CanonicalJsonValue).
    assert!(validator.validate(&CanonicalJsonValue::Null).is_ok());
    assert!(validator.validate(&doc(r##"{}"##)).is_err());
    assert!(validator.validate(&doc(r##"false"##)).is_err());
    assert!(validator.validate(&doc(r##"0"##)).is_err());
    assert!(validator.validate(&doc(r##"[]"##)).is_err());
}

// --- 7. invalid schema fails closed -------------------------------------
#[test]
fn invalid_schema_fails_closed_without_network_or_filesystem() {
    // Structurally malformed schema: "type" must be a string or array of
    // strings. The validator build must fail closed.
    let schema = doc(r##"{"type":42}"##);
    let digest = digest_of(&schema);
    assert!(SchemaValidator::compile_embedded(&schema, &digest).is_err());

    // Keyword misuse: properties must be an object.
    let schema = doc(r##"{"type":"object","properties":42}"##);
    let digest = digest_of(&schema);
    assert!(SchemaValidator::compile_embedded(&schema, &digest).is_err());

    // A local pointer that targets nothing is an unresolved reference and must
    // fail closed.
    let schema = doc(r##"{"$ref":"#/$defs/missing"}"##);
    let digest = digest_of(&schema);
    assert!(SchemaValidator::compile_embedded(&schema, &digest).is_err());
}
