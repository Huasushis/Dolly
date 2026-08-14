//! Vector runner for the bounded WP-021A ordered decision-state replay oracle.
//!
//! Loads the authoritative `TST-FILTER-006-decision-state-replay` vector from
//! the read-only imported `dolly-spec` tree and checks every `expected`
//! assertion (op `equals`, path form `/a/b/c`) and every `emitted` entry.
//! The runner exercises ONLY the ordered replay / claimed-after-state
//! comparison behavior that vector covers (spec `filter-two-thirds.md` §5:
//! start from `before_state`, apply observations in ascending
//! `manifest_ordinal` under the frozen config, and require the result to
//! equal `after_state`). It is not a generic Extension, digest, storage, or
//! activation-ledger runner: digest-level forgery kinds (`committed_before_state`,
//! `manifest_context_substitution`) are outside this arithmetic leaf and no
//! assertion path in the vector depends on them.

use std::{
    fs,
    path::{Path, PathBuf},
};

use dolly_filter_arithmetic::{
    replay_decision_state, Accumulator, FilterConfig, ReplayObservation, SCALE,
};
use serde_json::{json, Map, Value};

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

/// Parse the smoothing configuration from the TST-FILTER-006 `initial` block.
/// The sample weight and bias-correction flag are top-level (as authored);
/// `internal_scale` lives inside `before_state`; the normative fixed
/// `internal_scale = SCALE` is always used and `FilterConfig::new` rejects
/// any other value, so the arithmetic stays exact.
fn config(initial: &Value) -> Result<FilterConfig, String> {
    let before_state = &initial["before_state"];
    if let Some(scale) = before_state.get("internal_scale") {
        let scale = scale.as_u64().ok_or("internal_scale must be an integer")?;
        if scale != SCALE {
            return Err(format!(
                "non-normative internal_scale {scale}; the spec fixes R = {SCALE}"
            ));
        }
    }
    FilterConfig::new(
        initial["new_sample_weight_ppm"]
            .as_u64()
            .ok_or("new_sample_weight_ppm must be an integer")?,
        initial["bias_correction"]
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

fn evaluate_tst_filter_006(vector: &Value) -> Evaluated {
    let initial = &vector["initial"];
    let cfg = config(initial).expect("vector config must be in spec bounds");
    let stimulus = &vector["stimulus"];
    assert_eq!(
        stimulus["command"],
        "validate_prepared_decision_by_replaying_ordered_observations_from_before_state"
    );

    // Committed prior state: the schema's `AccumulatorState.sources` array of
    // per-source `SourceState`; this vector carries an empty array.
    let before_state: Vec<(&str, Accumulator)> = initial["before_state"]["sources"]
        .as_array()
        .expect("before_state.sources must be an array")
        .iter()
        .map(|source| {
            let name = source["source"].as_str().unwrap_or_else(|| {
                source["source_module_id"]
                    .as_str()
                    .expect("source identity")
            });
            (
                name,
                Accumulator {
                    accumulator: source["accumulator"].as_u64().expect("accumulator"),
                    weight: source["weight"].as_u64().expect("weight"),
                    observation_count: source["observation_count"]
                        .as_u64()
                        .expect("observation_count"),
                },
            )
        })
        .collect();

    // Trusted ordered observations: applied scores in ascending
    // `manifest_ordinal`. `projection_eligible` governs content selection
    // (TST-FILTER-004) and does not feed the EMA replay.
    let observations: Vec<ReplayObservation<'_>> = initial["ordered_observations"]
        .as_array()
        .expect("ordered_observations must be an array")
        .iter()
        .map(|obs| ReplayObservation {
            manifest_ordinal: obs["manifest_ordinal"].as_u64().expect("manifest_ordinal"),
            source: obs["source"].as_str().expect("source"),
            score: obs["score"].as_u64().expect("score"),
        })
        .collect();

    // The prepared decision's claimed after-state, reconstructed from the
    // forgeries it embeds: only `derived_accumulator` entries pin numeric
    // after-state values (accumulator + weight) for a source.
    let mut claimed_after_state: Vec<(&str, Accumulator)> = Vec::new();
    let mut claimed_map = Map::new();
    for forgery in initial["forgeries"]
        .as_array()
        .expect("forgeries must be an array")
    {
        if forgery["kind"] == "derived_accumulator" {
            let source = forgery["source"].as_str().expect("forged source");
            let accumulator = forgery["claimed_accumulator"]
                .as_u64()
                .expect("claimed_accumulator");
            let weight = forgery["claimed_weight"].as_u64().expect("claimed_weight");
            claimed_after_state.push((
                source,
                Accumulator {
                    accumulator,
                    weight,
                    observation_count: 0,
                },
            ));
            claimed_map.insert(
                source.to_string(),
                json!({ "accumulator": accumulator, "weight": weight }),
            );
        }
    }

    // Replay under the frozen config and compare against the claim.
    let replay = replay_decision_state(&cfg, &before_state, &observations, &claimed_after_state)
        .expect("replay arithmetic must stay in spec bounds");
    let mut derived_map = Map::new();
    for (source, acc) in &replay.derived_after_state {
        derived_map.insert(
            source.to_string(),
            json!({
                "accumulator": acc.accumulator,
                "weight": acc.weight,
                "observation_count": acc.observation_count,
            }),
        );
    }

    let mut result = Map::new();
    result.insert(
        "derived_after_state".to_string(),
        Value::Object(derived_map),
    );
    result.insert(
        "claimed_after_state".to_string(),
        Value::Object(claimed_map),
    );
    if replay.claimed_matches {
        result.insert(
            "accepted_forgery_count".to_string(),
            json!(claimed_after_state.len()),
        );
        result.insert("error".to_string(), Value::Null);
    } else {
        result.insert("accepted_forgery_count".to_string(), json!(0));
        result.insert(
            "error".to_string(),
            json!("FILTER_ORDERED_STATE_REPLAY_MISMATCH"),
        );
    }

    Evaluated {
        result: Value::Object(result),
        emitted: Vec::new(),
    }
}

#[test]
fn tst_filter_006_decision_state_replay() {
    let vector = read_vector("TST-FILTER-006-decision-state-replay");
    assert_eq!(vector["test_id"], "TST-FILTER-006");
    let evaluated = evaluate_tst_filter_006(&vector);
    check_assertions(&evaluated.result, &vector);
    check_emitted(&evaluated.emitted, &vector);
}
