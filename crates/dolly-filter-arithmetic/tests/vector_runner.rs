//! Vector runner for the bounded WP-021A arithmetic oracle.
//!
//! Loads the authoritative `TST-FILTER-001` and `TST-FILTER-003` vectors from
//! the read-only imported `dolly-spec` tree and checks every `expected`
//! assertion (op `equals`, path form `/a/b/c`) and every `emitted` entry.
//! The runner exercises ONLY the arithmetic/selection behavior those two
//! vectors cover; it is not a generic Extension or activation-ledger runner.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use dolly_filter_arithmetic::{
    Accumulator, Candidate, FilterConfig, SCALE, corrected_score_q, normalized_score,
    select_winner, update,
};
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

/// The cross-language seam carries `internal_scale` in each vector; the spec
/// fixes `R = SCALE`, so a vector declaring any other scale must be rejected
/// by `config` before any arithmetic runs.
#[test]
fn vector_rejects_non_fixed_internal_scale() {
    let mut vector = read_vector("TST-FILTER-003-fixed-point-boundary-saturation");
    vector["initial"]["internal_scale"] = json!(SCALE - 1);
    let err =
        config(&vector["initial"]).expect_err("non-normative internal_scale must be rejected");
    assert!(
        err.contains("internal_scale"),
        "unexpected rejection message: {err}"
    );
}

/// Parse the smoothing configuration from a vector `initial` block. Both the
/// `config`-nested layout (TST-FILTER-001) and the flat layout (TST-FILTER-003)
/// are accepted. The vector-declared `internal_scale` must be exactly the
/// normative fixed `R = SCALE`; any other value is rejected with a message.
fn config(initial: &Value) -> Result<FilterConfig, String> {
    let cfg = initial.get("config").unwrap_or(initial);
    if let Some(scale) = initial.get("internal_scale") {
        let scale = scale.as_u64().ok_or("internal_scale must be an integer")?;
        if scale != SCALE {
            return Err(format!(
                "non-normative internal_scale {scale}; the spec fixes R = {SCALE}"
            ));
        }
    }
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

fn evaluate_tst_filter_001(vector: &Value) -> Evaluated {
    let initial = &vector["initial"];
    let cfg = config(initial).expect("vector config must be in spec bounds");
    let stimulus = &vector["stimulus"];
    assert_eq!(
        stimulus["command"],
        "apply_distinct_observations_then_select"
    );

    let probe = &stimulus["ema_probe"];
    let probe_source = probe["source"].as_str().unwrap();
    let scores: Vec<u64> = probe["scores"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_u64().unwrap())
        .collect();
    assert_eq!(scores.len(), 2, "the vector exercises exactly two reads");

    let mut sources: BTreeMap<String, Accumulator> = initial["sources"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, state)| {
            (
                name.clone(),
                Accumulator {
                    accumulator: state["accumulator"].as_u64().unwrap(),
                    weight: state["weight"].as_u64().unwrap(),
                    observation_count: state["observation_count"].as_u64().unwrap(),
                },
            )
        })
        .collect();

    let acc = sources.get_mut(probe_source).unwrap();
    update(&cfg, acc, scores[0]).unwrap();
    let after_first_corrected = corrected_score_q(&cfg, acc).unwrap();
    update(&cfg, acc, scores[1]).unwrap();
    let after_second_accumulator = acc.accumulator;
    let after_second_weight = acc.weight;
    let after_second_corrected = corrected_score_q(&cfg, acc).unwrap();

    // Selection probe: corrected values are provided by the vector directly;
    // candidate order is the authorial key order (preserve_order).
    let probe_scores = &stimulus["selection_probe_corrected_scores_q"];
    let module_ids: Vec<String> = probe_scores.as_object().unwrap().keys().cloned().collect();
    let candidates: Vec<Candidate> = module_ids
        .iter()
        .map(|id| Candidate {
            module_id: id.clone(),
            corrected_score_q: probe_scores[id].as_u64().unwrap(),
        })
        .collect();
    let selection = select_winner("dolly-test-instance", "default", &candidates)
        .unwrap()
        .expect("non-empty cohort must select");

    let winner_index = selection.winner.expect("winner index");
    let winner_module = module_ids[winner_index].clone();
    let winner_q = probe_scores[&winner_module].as_u64().unwrap();
    let winner_normalized = normalized_score(&cfg, winner_q).unwrap();

    let mut selection_map = Map::new();
    for (index, id) in module_ids.iter().enumerate() {
        selection_map.insert(
            id.clone(),
            json!({ "distance": selection.distances[index] }),
        );
    }
    selection_map.insert(
        "target_score_q".to_string(),
        json!(selection.target_score_q),
    );
    selection_map.insert("winner".to_string(), json!(winner_module));

    Evaluated {
        result: json!({
            "ema_probe": {
                "after_first": { "corrected_score_q": after_first_corrected },
                "after_second": {
                    "accumulator": after_second_accumulator,
                    "weight": after_second_weight,
                    "corrected_score_q": after_second_corrected,
                },
            },
            "selection": Value::Object(selection_map),
        }),
        emitted: vec![json!({
            "kind": "selection",
            "source_module_id": winner_module,
            "normalized_score": winner_normalized,
        })],
    }
}

fn evaluate_tst_filter_003(vector: &Value) -> Evaluated {
    let initial = &vector["initial"];
    let cfg = config(initial).expect("vector config must be in spec bounds");
    let stimulus = &vector["stimulus"];
    assert_eq!(
        stimulus["command"],
        "apply_constant_upper_boundary_sequence"
    );

    let score = stimulus["score"].as_u64().unwrap();
    let count = stimulus["observation_count"].as_u64().unwrap();

    let mut acc = Accumulator {
        accumulator: initial["accumulator"].as_u64().unwrap(),
        weight: initial["weight"].as_u64().unwrap(),
        observation_count: 0,
    };
    for _ in 0..count {
        update(&cfg, &mut acc, score).unwrap();
    }

    let raw_q = corrected_score_q(&cfg, &acc).unwrap();
    let candidate_q = cfg.clamp_q(raw_q);
    let output_score = normalized_score(&cfg, candidate_q).unwrap();

    Evaluated {
        result: json!({
            "raw": {
                "accumulator": acc.accumulator,
                "weight": acc.weight,
                "corrected_score_q": raw_q,
            },
            "candidate": { "corrected_score_q": candidate_q },
            "output": { "normalized_score": output_score },
        }),
        emitted: vec![json!({
            "kind": "filter_signal",
            "channel": "default",
            "score": output_score,
        })],
    }
}

#[test]
fn tst_filter_001_bias_correction_and_selection() {
    let vector = read_vector("TST-FILTER-001-bias-correction-and-selection");
    assert_eq!(vector["test_id"], "TST-FILTER-001");
    let evaluated = evaluate_tst_filter_001(&vector);
    check_assertions(&evaluated.result, &vector);
    check_emitted(&evaluated.emitted, &vector);
}

#[test]
fn tst_filter_003_fixed_point_boundary_saturation() {
    let vector = read_vector("TST-FILTER-003-fixed-point-boundary-saturation");
    assert_eq!(vector["test_id"], "TST-FILTER-003");
    let evaluated = evaluate_tst_filter_003(&vector);
    check_assertions(&evaluated.result, &vector);
    check_emitted(&evaluated.emitted, &vector);
}
