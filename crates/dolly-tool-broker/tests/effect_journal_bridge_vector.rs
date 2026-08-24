//! Cross-language JCS corpus checks for the explicit bridge contract.
//!
//! This test consumes the shared vector through the real Rust canonical JSON and
//! effect-journal record types. It does not claim a daemon-to-Worker transport;
//! that public channel remains an integration prerequisite.

use dolly_canonical_json::{ParseLimits, canonicalize, parse_core_json};
use dolly_tool_broker::effect_journal::ExternalEffectJournalRecord;
use serde_json::Value;

const VECTOR: &str = include_str!(
    "../../../dolly-spec/test-vectors/services/TST-TOOL-014-cross-language-effect-journal.json"
);

fn object<'a>(value: &'a Value, field: &str) -> &'a Value {
    value
        .get(field)
        .unwrap_or_else(|| panic!("missing vector field {field}"))
}

fn string<'a>(value: &'a Value, field: &str) -> &'a str {
    object(value, field)
        .as_str()
        .unwrap_or_else(|| panic!("vector field {field} is not a string"))
}

#[test]
fn validates_rust_records_and_exact_shared_jcs_bytes() {
    let vector: Value = serde_json::from_str(VECTOR).expect("valid bridge vector JSON");
    let initial = object(&vector, "initial");
    let contract = object(initial, "contract");
    assert_eq!(string(contract, "schema"), "dolly.effect-journal-bridge/v1");
    assert_eq!(string(object(contract, "source"), "dialect"), "typescript");
    assert_eq!(string(object(contract, "target"), "dialect"), "rust");
    assert_eq!(
        string(object(contract, "canonicalization"), "scheme"),
        "RFC8785-JCS"
    );
    assert_eq!(
        string(object(contract, "ordering"), "first_external_write"),
        "after-claim-intent-commit"
    );
    assert_eq!(
        string(contract, "aggregate_evidence"),
        "never-map-evidenceForRun-directly-to-one-Rust-record; require-each-intent-outcome"
    );
    assert_eq!(
        object(initial, "public_bridge"),
        &serde_json::json!({
            "daemon_to_worker_transport": "absent",
            "ffi": "absent",
            "disposition": "blocked-no-go",
        })
    );

    let cases = object(initial, "cases")
        .as_array()
        .expect("bridge cases array");
    assert_eq!(cases.len(), 4);
    for case in cases {
        let target = object(case, "target");
        let claim = object(target, "claim");
        let record_value = object(target, "record");
        let canonical = object(case, "canonical");
        let (claim_bytes, claim_digest) = canonicalize(claim).expect("canonical Claim");
        assert_eq!(
            claim_bytes.as_ref(),
            string(canonical, "claim_utf8").as_bytes()
        );
        assert_eq!(
            claim_digest.to_canonical_string(),
            string(canonical, "claim_digest")
        );

        let record: ExternalEffectJournalRecord =
            serde_json::from_value(record_value.clone()).expect("closed Rust journal record");
        record.verify().expect("Claim and journal identity verify");
        let (record_bytes, record_digest) = record
            .canonical_bytes_and_digest()
            .expect("canonical external-effect journal record");
        assert_eq!(
            record_bytes.as_ref(),
            string(canonical, "record_utf8").as_bytes()
        );
        assert_eq!(
            record_digest.to_canonical_string(),
            string(canonical, "record_digest")
        );
        assert_eq!(
            record.state.wire_name(),
            string(case, "expected_state")
        );

        // Feed the exact bytes through the duplicate-rejecting wire parser at
        // the shared protocol depth instead of trusting serde_json alone.
        let parsed = parse_core_json(
            record_bytes.as_ref(),
            ParseLimits::new(96).expect("wire depth"),
        )
        .expect("record bytes parse under the wire depth");
        assert!(matches!(parsed, dolly_canonical_json::CanonicalJsonValue::Object(_)));
    }
}

#[test]
fn preserves_separate_extension_and_mcp_frame_profiles() {
    let vector: Value = serde_json::from_str(VECTOR).expect("valid bridge vector JSON");
    let transport = object(object(&vector, "initial"), "canonical_transport");
    let extension_payload = string(transport, "extension_payload_utf8");
    let payload_bytes = extension_payload.as_bytes();
    assert_eq!(payload_bytes.len(), 109);
    assert_eq!(
        u32::from_be_bytes([0, 0, 0, payload_bytes.len() as u8]),
        109
    );
    assert_eq!(string(transport, "mcp_line_utf8"), format!("{extension_payload}\n"));
    assert_eq!(
        object(transport, "mcp_line_bytes")
            .as_u64()
            .expect("MCP line byte count") as usize,
        payload_bytes.len() + 1
    );
    assert_eq!(object(transport, "extension_wire_depth").as_u64(), Some(3));
    assert_eq!(object(transport, "mcp_wire_depth").as_u64(), Some(3));
}
