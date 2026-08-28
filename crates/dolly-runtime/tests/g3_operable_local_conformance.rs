//! External G3 operable-local substrate conformance.
//!
//! The handoff under test is deliberately smaller than a new authority layer:
//! an accepted G2 invocation context reaches one daemon-supervised local
//! operational premise, then stops before external I/O. The valid boundary is
//! one product-red case; the invalid controls point to the accepted G1, G2,
//! and work-package tests instead of repeating them here.

use serde_json::{json, Value};

const G1_MATRIX: &str = include_str!("fixtures/g1_runtime_conformance.json");
const G2_MATRIX: &str = include_str!("fixtures/g2_extension_host_sdk_conformance.json");
const G3_MATRIX: &str = include_str!("fixtures/g3_operable_local_conformance.json");

fn document(source: &str, label: &str) -> Value {
    serde_json::from_str(source)
        .unwrap_or_else(|error| panic!("{label} fixture must be valid JSON: {error}"))
}

fn case<'a>(document: &'a Value, id: &str, label: &str) -> &'a Value {
    document["cases"]
        .as_array()
        .unwrap_or_else(|| panic!("{label} matrix cases must be an array"))
        .iter()
        .find(|candidate| candidate["id"] == id)
        .unwrap_or_else(|| panic!("{label} matrix case {id} is missing"))
}

#[test]
fn g3_operable_local_001_valid_committed_g2_invocation_reaches_supervised_local_premise_before_io()
{
    let g1 = document(G1_MATRIX, "accepted G1");
    let g2 = document(G2_MATRIX, "accepted G2");
    let g3 = document(G3_MATRIX, "G3");
    let source_boundary = &g3["source_boundary"];
    let g1_case = case(&g1, "G1-EXEC-001", "accepted G1");
    let g2_case = case(&g2, "G2-ADMISSION-001", "accepted G2");
    let g3_case = case(&g3, "G3-OPERABLE-LOCAL-001", "G3");

    assert_eq!(
        source_boundary["g1_fixture"],
        "crates/dolly-runtime/tests/fixtures/g1_runtime_conformance.json"
    );
    assert_eq!(
        source_boundary["g2_fixture"],
        "crates/dolly-runtime/tests/fixtures/g2_extension_host_sdk_conformance.json"
    );
    assert_eq!(source_boundary["g1_case"], g1_case["id"]);
    assert_eq!(source_boundary["g2_case"], g2_case["id"]);
    assert_eq!(g1_case["expected"], "product_red");
    assert_eq!(g2_case["expected"], "product_red");
    assert_eq!(g2_case["source_case"], g1_case["id"]);

    assert_eq!(g3_case["expected"], "product_red");
    assert_eq!(g3_case["source_case"], g2_case["id"]);
    assert_eq!(g3_case["fences"], g2_case["fences"]);
    assert_eq!(
        g3_case["required_boundary"],
        "one explicit supervised-local operational premise"
    );
    assert_eq!(g3_case["effect_boundary"], "before external I/O");
    assert_eq!(
        source_boundary["effect_boundary"],
        g3_case["effect_boundary"]
    );
    assert_eq!(
        g3_case["stop_conditions"],
        json!([
            "no credential resolution",
            "no external transport invocation",
            "no new authority or storage scope"
        ])
    );
}

#[test]
fn g3_matrix_has_one_valid_red_and_only_pass_fail_closed_controls() {
    let g3 = document(G3_MATRIX, "G3");
    let cases = g3["cases"]
        .as_array()
        .expect("G3 matrix cases must be an array");

    let product_red_cases: Vec<&Value> = cases
        .iter()
        .filter(|candidate| candidate["expected"] == "product_red")
        .collect();
    assert_eq!(
        product_red_cases.len(),
        1,
        "G3 must freeze one causal product-red path"
    );
    assert_eq!(product_red_cases[0]["kind"], "valid_operational_premise");

    let controls: Vec<&Value> = cases
        .iter()
        .filter(|candidate| candidate["kind"] == "fail_closed_control")
        .collect();
    assert_eq!(
        controls.len(),
        6,
        "G3 must keep the external invalid-control matrix minimal"
    );
    assert!(
        cases
            .iter()
            .all(|candidate| candidate["expected"] != "skip"),
        "G3 must not encode skipped cases"
    );

    for control in controls {
        assert_eq!(control["expected"], "pass");
        let references = control["references"]
            .as_array()
            .unwrap_or_else(|| panic!("{} must reference an accepted control", control["id"]));
        assert!(!references.is_empty());
        assert!(references.iter().all(|reference| {
            reference
                .as_str()
                .is_some_and(|value| !value.trim().is_empty())
        }));
    }
}
