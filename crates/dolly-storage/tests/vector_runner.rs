//! Conformance vector runner for the first storage slice.
//!
//! Loads TST-STORAGE-001 and TST-STORAGE-002 from the authoritative spec
//! (the worktree `dolly-spec` mirror, byte-identical to the import), feeds
//! `initial.release_attestation` and `initial.loaded_sqlite` through
//! `SqliteBuildGate`, and asserts the normative outcome, `/instance/*`
//! fields, and emitted records. Fixture values are never copied into this
//! file — the JSON is the single source of truth.

use std::path::{Path, PathBuf};

use dolly_storage::attestation::{LoadedSqlite, ReleaseAttestation, SqliteBuildGate};
use serde_json::{Value, json};

fn spec_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("dolly-spec")
}

fn read_vector(name: &str) -> Value {
    let path = spec_root().join("test-vectors/core").join(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "missing authoritative vector {} at {}: {}",
            name,
            path.display(),
            e
        )
    });
    serde_json::from_slice(&bytes).expect("vector is valid JSON")
}

/// Run the gate on one vector's `initial` records and map the verdict onto
/// the instance-state fields asserted by the vector.
fn run_gate(vector: &Value) -> (String, Value, Value) {
    let attestation: ReleaseAttestation =
        serde_json::from_value(vector["initial"]["release_attestation"].clone())
            .expect("release_attestation deserializes into closed type");
    let loaded: LoadedSqlite = serde_json::from_value(vector["initial"]["loaded_sqlite"].clone())
        .expect("loaded_sqlite deserializes into closed type");

    let instance = json!({
        "instance": {
            "write_opened": false,
            "sqlite_build_verified": false,
            "write_open_permitted": false,
            "migration_started": false,
            "recovery_write_started": false,
        }
    });

    match SqliteBuildGate.verify(&attestation, &loaded) {
        Ok(verified) => {
            let mut instance = instance;
            instance["instance"]["sqlite_build_verified"] = true.into();
            instance["instance"]["write_open_permitted"] = true.into();
            let emitted = json!([{
                "event": "SqliteBuildVerified",
                "version_number": verified.version_number,
            }]);
            ("sqlite_build_gate_passed".into(), instance, emitted)
        }
        Err(err) => {
            let emitted = json!([{
                "error": err.code(),
                "retryable": err.retryable(),
            }]);
            (err.code().to_string(), instance, emitted)
        }
    }
}

#[test]
fn storage_vectors_execute() {
    let cases = [
        "TST-STORAGE-001-reject-vulnerable-sqlite.json",
        "TST-STORAGE-002-accept-fixed-sqlite.json",
    ];
    for name in cases {
        let vector = read_vector(name);
        let expected = &vector["expected"];

        assert_eq!(
            vector["schema"], "dolly.test-vector/v1",
            "{name}: schema must be the canonical vector schema"
        );

        let expected_outcome = expected
            .get("outcome")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("{name}: fixture expected.outcome must be a string"));
        let (outcome, mut instance, emitted) = run_gate(&vector);
        assert_eq!(outcome, expected_outcome, "{name}: outcome");

        for assertion in expected["assertions"].as_array().unwrap() {
            let path = assertion["path"].as_str().unwrap();
            let op = assertion["op"].as_str().unwrap();
            assert_eq!(op, "equals", "{name}: first-slice vectors use equals");
            let mut cursor = &mut instance;
            for segment in path.trim_start_matches('/').split('/') {
                cursor = cursor
                    .get_mut(segment)
                    .unwrap_or_else(|| panic!("{name}: instance path {path} absent"));
            }
            assert_eq!(cursor, &assertion["value"], "{name}: {path}");
        }

        assert_eq!(
            emitted,
            expected["emitted"].clone(),
            "{name}: emitted records"
        );
    }
}

/// Malformed or extra attestation data must fail closed, never be ignored.
#[test]
fn malformed_attestation_fails_closed() {
    let vector = read_vector("TST-STORAGE-002-accept-fixed-sqlite.json");
    let attestation_value = vector["initial"]["release_attestation"].clone();

    // Extra unknown field on the attestation.
    let mut extra = attestation_value.clone();
    extra["unexpected_field"] = Value::String("x".into());
    assert!(
        serde_json::from_value::<ReleaseAttestation>(extra).is_err(),
        "unknown attestation field must fail closed"
    );

    // Malformed digest.
    let mut bad_digest = attestation_value.clone();
    bad_digest["artifact_digest"] = Value::String("not-sha256".into());
    assert!(
        serde_json::from_value::<ReleaseAttestation>(bad_digest).is_err(),
        "malformed digest must fail closed"
    );

    // Missing required field.
    let mut missing = attestation_value.clone();
    missing
        .as_object_mut()
        .unwrap()
        .remove("sqlite_version_number_min");
    assert!(
        serde_json::from_value::<ReleaseAttestation>(missing).is_err(),
        "missing required field must fail closed"
    );
}
