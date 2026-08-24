use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use dolly_core_reducer::validate_disposition_candidate;
use serde_json::Value;

/// The repository-vendored dolly-spec fixture subtree (byte-identical to the
/// authoritative spec import) is where every crate vector test reads fixtures.
fn spec_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("dolly-spec")
}
fn read_vector() -> Value {
    serde_json::from_slice(
        &fs::read(spec_root().join("test-vectors/config/TST-CONFIG-002-disposition-target.json"))
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn tst_config_002_disposition_target_vector() {
    let vector = read_vector();
    assert_eq!(vector["schema"], "dolly.test-vector/v1");
    assert_eq!(vector["test_id"], "TST-CONFIG-002");
    assert_eq!(vector["kind"], "config");
    assert_eq!(
        vector["expected"]["outcome"],
        "only_closed_transfer_shape_accepted"
    );

    // Build `/cases/<name>/valid` expectations from the fixture assertions.
    let mut expected_valid: BTreeMap<&str, bool> = BTreeMap::new();
    for assertion in vector["expected"]["assertions"].as_array().unwrap() {
        let path: Vec<&str> = assertion["path"].as_str().unwrap().split('/').collect();
        assert_eq!(path.len(), 4, "assertion path must be /cases/<name>/valid");
        assert_eq!(path[1], "cases");
        assert_eq!(path[3], "valid");
        expected_valid.insert(path[2], assertion["value"].as_bool().unwrap());
    }

    let cases = vector["stimulus"]["validate_candidates"]
        .as_array()
        .unwrap();
    assert!(!cases.is_empty());
    assert_eq!(
        expected_valid.len(),
        cases.len(),
        "every case needs an assertion"
    );

    let mut accepted = 0usize;
    for case in cases {
        let name = case["case"].as_str().unwrap();
        // `case` is a test-vector label, not configuration content.
        let mut candidate = case.clone();
        candidate.as_object_mut().unwrap().remove("case");
        let valid = validate_disposition_candidate(&candidate).is_ok();
        assert_eq!(valid, expected_valid[name], "case {name}");
        if valid {
            accepted += 1;
        }
    }
    // Only the closed transfer shape is accepted: exactly the asserted cases.
    assert_eq!(accepted, expected_valid.values().filter(|v| **v).count());
}
