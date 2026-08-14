//! Vector runner for the bounded WP-021A state-header transition oracle.
//!
//! Loads the authoritative `TST-FILTER-005-state-header-config-fence` vector
//! from the read-only imported `dolly-spec` tree and checks every `expected`
//! assertion (ops `equals` and `count`, path form `/a/b/c`) and every
//! `emitted` entry against the pure prepare/restart state-header transitions
//! (spec `filter-two-thirds.md` §6: populated state cannot be reinterpreted
//! by a bias toggle over the unchanged epoch, a restart is a pure preserve
//! transition, and a fresh state epoch starts state with no inherited
//! observations). It is not a generic Extension, storage, or activation-ledger
//! runner: there is no codec, file, or reopen boundary and nothing is
//! durable, so `crash_label` (null) and `emitted` (empty) have no surface to
//! drive.

use std::{
    fs,
    path::{Path, PathBuf},
};

use dolly_filter_arithmetic::{
    EpochMode, FilterStateHeader, FilterStateHeaderError, prepare_config, restart,
};
use serde_json::{Map, Value, json};

/// Caller-supplied opaque state epoch identifiers. The spec fixes
/// `state_epoch` as a `StableId` supplied by the caller; this leaf grants no
/// authority to generate, validate, or persist epochs, so the runner supplies
/// the two in-memory identifiers it needs.
const RUNNER_SUPPLIED_EPOCH_INITIAL: &str = "caller-supplied-epoch-1";
const RUNNER_SUPPLIED_EPOCH_FRESH: &str = "caller-supplied-epoch-2";

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

fn navigate<'a>(value: &'a Value, path: &str) -> &'a Value {
    let mut current = value;
    for segment in path.trim_start_matches('/').split('/') {
        current = match current {
            Value::Array(array) => match segment.parse::<usize>() {
                Ok(index) => array
                    .get(index)
                    .unwrap_or_else(|| panic!("array index {index} out of bounds at {path}")),
                Err(_) => panic!("non-numeric segment {segment} on array at {path}"),
            },
            _ => &current[segment],
        };
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
        match op {
            "equals" => assert_eq!(
                actual, &assertion["value"],
                "TST-FILTER assertion failed at {path}"
            ),
            "count" => {
                let expected = assertion["value"]
                    .as_u64()
                    .expect("count value must be an integer");
                let count = actual
                    .as_array()
                    .unwrap_or_else(|| panic!("count op requires an array at {path}"))
                    .len() as u64;
                assert_eq!(count, expected, "TST-FILTER assertion failed at {path}");
            }
            other => panic!("unsupported assertion op {other}"),
        }
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

fn evaluate_tst_filter_005(vector: &Value) -> Evaluated {
    let initial = &vector["initial"];
    let header_json = &initial["state_header"];

    // Frozen initial state header from the vector's `initial` block. The
    // vector does not author a `state_epoch`; the runner supplies the opaque
    // identifier (caller-supplied, no authority).
    let header = FilterStateHeader::new(
        initial["storage_scope_id"]
            .as_str()
            .expect("storage_scope_id"),
        initial["channel"].as_str().expect("channel"),
        header_json["algorithm_revision"]
            .as_str()
            .expect("algorithm_revision"),
        header_json["internal_scale"]
            .as_u64()
            .expect("internal_scale"),
        header_json["bias_correction"]
            .as_bool()
            .expect("bias_correction"),
        header_json["observation_count"]
            .as_u64()
            .expect("observation_count"),
        RUNNER_SUPPLIED_EPOCH_INITIAL,
    )
    .expect("initial state header must be in spec bounds");

    let commands = vector["stimulus"]["commands"]
        .as_array()
        .expect("stimulus.commands must be an array");

    // Apply the command tape as a pure transition chain over the header
    // value; the header is never persisted or reopened.
    let mut header = header;
    let mut commands_result: Vec<Value> = Vec::with_capacity(commands.len());
    for command in commands {
        let operation = command["operation"].as_str().expect("operation");
        let bias_correction = command["bias_correction"]
            .as_bool()
            .expect("bias_correction");
        let mut entry = Map::new();
        match operation {
            "prepare_config" => {
                let state_epoch = command["state_epoch"].as_str().expect("state_epoch");
                let epoch = match state_epoch {
                    "unchanged" => EpochMode::Unchanged,
                    "fresh" => EpochMode::Fresh(RUNNER_SUPPLIED_EPOCH_FRESH),
                    other => panic!("unknown state_epoch mode {other}"),
                };
                match prepare_config(&header, bias_correction, epoch) {
                    Ok(next) => {
                        header = next;
                        entry.insert("outcome".to_string(), json!("fresh_state_epoch_prepared"));
                        entry.insert(
                            "inherited_observation_count".to_string(),
                            json!(header.observation_count()),
                        );
                    }
                    Err(FilterStateHeaderError::Conflict) => {
                        entry.insert(
                            "error".to_string(),
                            json!(FilterStateHeaderError::Conflict.wire_code().unwrap()),
                        );
                        entry.insert("state_mutations".to_string(), Value::Array(Vec::new()));
                    }
                    Err(other) => panic!("unexpected state-header error {other:?}"),
                }
            }
            "restart" => match restart(&header, bias_correction) {
                Ok(next) => {
                    header = next;
                    let mut state_header = Map::new();
                    state_header.insert(
                        "bias_correction".to_string(),
                        json!(header.bias_correction()),
                    );
                    state_header.insert(
                        "observation_count".to_string(),
                        json!(header.observation_count()),
                    );
                    state_header.insert(
                        "algorithm_revision".to_string(),
                        json!(header.algorithm_revision()),
                    );
                    state_header
                        .insert("internal_scale".to_string(), json!(header.internal_scale()));
                    entry.insert("state_header".to_string(), Value::Object(state_header));
                    entry.insert(
                        "storage_scope_id".to_string(),
                        json!(header.storage_scope_id()),
                    );
                    entry.insert("state_mutations".to_string(), Value::Array(Vec::new()));
                }
                Err(FilterStateHeaderError::Conflict) => {
                    entry.insert(
                        "error".to_string(),
                        json!(FilterStateHeaderError::Conflict.wire_code().unwrap()),
                    );
                    entry.insert("state_mutations".to_string(), Value::Array(Vec::new()));
                }
                Err(other) => panic!("unexpected state-header error {other:?}"),
            },
            other => panic!("unknown operation {other}"),
        }
        commands_result.push(Value::Object(entry));
    }

    let mut result = Map::new();
    result.insert("commands".to_string(), Value::Array(commands_result));
    Evaluated {
        result: Value::Object(result),
        emitted: Vec::new(),
    }
}

#[test]
fn tst_filter_005_state_header_config_fence() {
    let vector = read_vector("TST-FILTER-005-state-header-config-fence");
    assert_eq!(vector["test_id"], "TST-FILTER-005");
    let evaluated = evaluate_tst_filter_005(&vector);
    check_assertions(&evaluated.result, &vector);
    check_emitted(&evaluated.emitted, &vector);
}
