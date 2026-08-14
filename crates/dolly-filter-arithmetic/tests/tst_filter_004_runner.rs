//! Vector runner for the bounded WP-021A ordered block-sequence oracle.
//!
//! Loads the authoritative `TST-FILTER-004-latest-eligible-multiblock` vector
//! from the read-only imported `dolly-spec` tree and checks every `expected`
//! assertion (op `equals`, path form `/a/b/c`) and every `emitted` entry.
//! The runner exercises ONLY the ordered block-application / latest-eligible
//! selection behavior that vector covers: it is not a generic Extension or
//! activation-ledger runner and contains no persistence or manifest scanning.

use std::{
    fs,
    path::{Path, PathBuf},
};

use dolly_filter_arithmetic::{BlockInput, BlockSignal, FilterConfig, SCALE, apply_block_sequence};
use serde_json::{Map, Value, json};

fn spec_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("dolly-spec")
}

fn read(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn read_vector(name: &str) -> Value {
    let vector = read(
        spec_root()
            .join("test-vectors/extensions")
            .join(format!("{name}.json")),
    );
    assert_eq!(vector["schema"], "dolly.test-vector/v1");
    assert_eq!(vector["kind"], "extension");
    vector
}

/// Parse the smoothing configuration from the nested vector `initial.config`
/// block (same layout as TST-FILTER-001). The normative fixed
/// `internal_scale = SCALE` is always used; `FilterConfig::new` rejects
/// any other value, so the arithmetic stays exact.
fn config(initial: &Value) -> Result<FilterConfig, String> {
    let cfg = initial.get("config").unwrap_or(initial);
    FilterConfig::new(
        cfg["new_sample_weight_ppm"]
            .as_u64()
            .ok_or("new_sample_weight_ppm must be an integer")?,
        cfg["bias_correction"]
            .as_bool()
            .ok_or("bias_correction must be a boolean")?,
        SCALE,
    )
    .map_err(|e| format!("{e:?}"))
}

fn navigate<'a>(value: &'a Value, path: &str) -> &'a Value {
    let mut current = value;
    for segment in path.trim_start_matches('/').split('/') {
        current = &current[segment];
    }
    current
}

fn check_assertions(result: &Value, vector: &Value) {
    for assertion in vector["expected"]["assertions"]
        .as_array()
        .expect("expected.assertions must be an array")
    {
        let path = assertion["path"].as_str().expect("assertion path");
        let actual = navigate(result, path);
        let op = assertion["op"].as_str().expect("assertion op");
        assert_eq!(
            op, "equals",
            "only the equals op is exercised by the selected vectors"
        );
        assert_eq!(
            actual, &assertion["value"],
            "TST-FILTER assertion failed at {path}"
        );
    }
}

fn check_emitted(actual: &[Value], vector: &Value) {
    let expected = vector["expected"]["emitted"]
        .as_array()
        .expect("expected.emitted must be an array");
    assert_eq!(actual.len(), expected.len(), "emitted entry count");
    for (actual_entry, expected_entry) in actual.iter().zip(expected.iter()) {
        assert_eq!(actual_entry, expected_entry, "emitted entry mismatch");
    }
}

/// One evaluated vector: the assertion-addressable result tree plus the
/// emitted entries.
struct Evaluated {
    result: Value,
    emitted: Vec<Value>,
}

fn evaluate_tst_filter_004(vector: &Value) -> Evaluated {
    let initial = &vector["initial"];
    let cfg = config(initial).expect("vector config must be in spec bounds");
    let stimulus = &vector["stimulus"];
    assert_eq!(
        stimulus["command"],
        "process_each_manifest_in_canonical_delivery_order_and_select_latest_eligible_block"
    );

    let mut result = Map::new();
    let mut emitted = Vec::new();

    for case in initial["cases"]
        .as_array()
        .expect("initial.cases must be an array")
    {
        let name = case["name"].as_str().expect("case name");
        // Authorial block order is the canonical delivery order; it is
        // preserved by the array and applied unchanged.
        let blocks: Vec<BlockInput<'_>> = case["blocks"]
            .as_array()
            .expect("blocks must be an array")
            .iter()
            .map(|block| BlockInput {
                block_id: block["block"].as_str().expect("block id"),
                signal: match block["signal"].as_u64() {
                    Some(score) => BlockSignal::WellFormed(score),
                    None => BlockSignal::Malformed,
                },
                projectable: block["projectable"].as_bool().expect("projectable"),
            })
            .collect();

        let outcome =
            apply_block_sequence(&cfg, &blocks).expect("ordered block application succeeds");

        result.insert(
            name.to_string(),
            json!({
                "selected_block": outcome.selected_block_id,
                "state_score": outcome.normalized_score,
                "state_observations": outcome.observation_updates,
                "output_normalized_score": outcome.normalized_score,
            }),
        );
        if let Some(selected) = outcome.selected_block_id {
            emitted.push(json!({
                "kind": "new_block_draft",
                "case": name,
                "source_block": selected,
            }));
        }
    }

    Evaluated {
        result: Value::Object(result),
        emitted,
    }
}

#[test]
fn tst_filter_004_latest_eligible_multiblock() {
    let vector = read_vector("TST-FILTER-004-latest-eligible-multiblock");
    assert_eq!(vector["test_id"], "TST-FILTER-004");
    let evaluated = evaluate_tst_filter_004(&vector);
    check_assertions(&evaluated.result, &vector);
    check_emitted(&evaluated.emitted, &vector);
}
