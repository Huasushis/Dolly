//! Vector runner for the bounded WP-021A two-phase decision oracle.
//!
//! Loads the authoritative `TST-FILTER-002-hold-dedup-and-safe-copy` vector
//! from the read-only imported `dolly-spec` tree and checks every `expected`
//! assertion (ops `equals`, `count`, `absent`, path form `/a/b/c`) and every
//! `emitted` entry. The runner exercises ONLY the decision-state behavior
//! that vector covers (spec `filter-two-thirds.md` §2, §4, §5: per-source
//! trust with holds on missing signals and never-seen ineligibility, one
//! observation per Block regardless of Pages, default self-source exclusion,
//! the v1 safe-copy zeros, and the prepared-decision lifecycle that promotes
//! the retained decision exactly once after an ambiguous interruption). It
//! is not a generic Extension, digest, storage, or activation-ledger runner;
//! EMA deltas of fresh signals are the accumulator-level replay oracle's
//! domain (TST-FILTER-006).

use dolly_filter_arithmetic::{
    BlockSignal, DecisionLifecycle, FilterConfig, HostActivationStatus, ManifestBlock, Promotion,
    SCALE, TrackedSource, prepare_decision,
};
use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};

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

fn navigate<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    value.pointer(path)
}

fn check_assertions(result: &Value, vector: &Value) {
    for assertion in vector["expected"]["assertions"]
        .as_array()
        .expect("expected.assertions must be an array")
    {
        let path = assertion["path"].as_str().expect("assertion path");
        let op = assertion["op"].as_str().expect("assertion op");
        match op {
            "absent" => assert!(
                navigate(result, path).is_none(),
                "TST-FILTER assertion failed at {path}: expected the path to be absent"
            ),
            "count" => {
                let expected = assertion["value"].as_u64().expect("count assertion value");
                let actual = navigate(result, path)
                    .expect("count assertion addresses a present array")
                    .as_array()
                    .expect("count assertion addresses an array")
                    .len() as u64;
                assert_eq!(actual, expected, "TST-FILTER assertion failed at {path}");
            }
            "equals" => {
                let actual = navigate(result, path).expect("equals assertion path present");
                assert_eq!(
                    actual, &assertion["value"],
                    "TST-FILTER assertion failed at {path}"
                );
            }
            other => panic!("unsupported assertion op {other:?}"),
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

fn evaluate_tst_filter_002(vector: &Value) -> Evaluated {
    let initial = &vector["initial"];
    let stimulus = &vector["stimulus"];
    assert_eq!(
        stimulus["command"],
        "process_manifest_twice_across_crash_reconciliation"
    );
    assert_eq!(stimulus["crash_after"], "prepared_decision_fsync");
    assert_eq!(stimulus["host_activation_status"], "committed");

    // The vector's `initial` carries no smoothing configuration block: this
    // cohort applies no fresh signal (the only valid signal in the Manifest
    // is self-excluded), so only the fixed normative scale participates. The
    // normative defaults keep the arithmetic exact.
    let cfg = FilterConfig::new(SCALE, true, SCALE).expect("normative config");
    let instance_id = "dolly-test-instance";
    let channel = "default";
    // The Filter Module's own configured identity: a Block produced by this
    // same Filter is ignored by default (spec §2), so `filter-main`'s valid
    // signal below never votes, is never observed, and stays off the cohort.
    let self_module_id = "filter-main";

    let tracked: Vec<TrackedSource<'_>> = initial["tracked"]
        .as_object()
        .expect("tracked must be an object")
        .iter()
        .map(|(source, state)| TrackedSource {
            source,
            corrected_score: state["corrected_score"].as_u64(),
            observation_count: state["observation_count"]
                .as_u64()
                .expect("observation_count"),
        })
        .collect();

    // Blocks arrive from the trusted Manifest; a Block delivered through
    // several Pages is still one Block record and therefore one observation.
    let manifest: Vec<ManifestBlock<'_>> = initial["manifest"]
        .as_array()
        .expect("manifest must be an array")
        .iter()
        .map(|block| ManifestBlock {
            source: block["source"].as_str().expect("source"),
            block_id: block["block_id"].as_str().expect("block_id"),
            signal: match block.get("signal") {
                Some(Value::String(text)) if text == "missing" => None,
                Some(Value::Number(number)) => {
                    Some(BlockSignal::WellFormed(number.as_u64().expect("score")))
                }
                _ => Some(BlockSignal::Malformed),
            },
            actions: block["actions"].as_u64().expect("actions"),
            action_results: block["action_results"].as_u64().expect("action_results"),
        })
        .collect();

    // Dispatch 1: compute the decision and durably record it, then crash
    // after `prepared_decision_fsync`. The recorded decision survives.
    let prepared = prepare_decision(&cfg, instance_id, channel, self_module_id, &tracked, &manifest)
        .expect("vector must stay in spec bounds");

    // Dispatch 2 (redispatch of the same Activation): reconciliation queries
    // the Host disposition and promotes the RETAINED decision exactly once.
    // The redispatch does not reread the Manifest, recompute the projection,
    // or apply observations again; the draft is emitted only by the single
    // promotion.
    let mut lifecycle = DecisionLifecycle::new();
    let mut emitted = Vec::new();
    match lifecycle.promote(HostActivationStatus::Committed) {
        Promotion::Applied => {
            if let Some(draft) = prepared.draft.as_ref() {
                emitted.push(json!({
                    "kind": "new_block_draft",
                    "source_module_id": draft.source_module_id,
                    "normalized_score": draft.normalized_score,
                }));
            }
        }
        _ => panic!("the authoritative committed disposition must promote exactly once"),
    }
    let apply_count = lifecycle.apply_count();

    // A further redispatch of the same Activation returns the retained result
    // and never reapplies observations or re-emits the BlockDraft.
    assert_eq!(
        lifecycle.promote(HostActivationStatus::Committed),
        Promotion::Retained
    );
    assert_eq!(lifecycle.apply_count(), 1);
    assert_eq!(emitted.len(), 1, "only the single promotion emits the draft");

    let mut state_map = Map::new();
    for entry in &prepared.after_state {
        state_map.insert(
            entry.source.to_string(),
            json!({
                "corrected_score": entry.corrected_score,
                "observation_count": entry.observation_count,
            }),
        );
    }

    let mut output = Map::new();
    output.insert(
        "actions".to_string(),
        Value::Array(
            prepared
                .output
                .actions
                .iter()
                .map(|_| Value::Null)
                .collect(),
        ),
    );
    output.insert(
        "action_results".to_string(),
        Value::Array(
            prepared
                .output
                .action_results
                .iter()
                .map(|_| Value::Null)
                .collect(),
        ),
    );
    output.insert(
        "copied_json_parts".to_string(),
        Value::Array(
            prepared
                .output
                .copied_json_parts
                .iter()
                .map(|_| Value::Null)
                .collect(),
        ),
    );
    output.insert(
        "copied_metadata_namespaces".to_string(),
        Value::Array(
            prepared
                .output
                .copied_metadata_namespaces
                .iter()
                .map(|_| Value::Null)
                .collect(),
        ),
    );
    output.insert(
        "foreign_filter_signals".to_string(),
        Value::Array(
            prepared
                .output
                .foreign_filter_signals
                .iter()
                .map(|_| Value::Null)
                .collect(),
        ),
    );
    output.insert(
        "filter_signals_for_default".to_string(),
        Value::Array(
            prepared
                .output
                .filter_signals_for_default
                .iter()
                .map(|signal| json!({ "channel": signal.channel, "score": signal.score }))
                .collect(),
        ),
    );
    // `envelope_identity` is deliberately absent: REQ-FILTER-003 never copies
    // the input Block envelope identity into the projection.

    let mut result = Map::new();
    result.insert("state".to_string(), Value::Object(state_map));
    result.insert(
        "candidates".to_string(),
        Value::Array(
            prepared
                .candidates
                .iter()
                .map(|source| Value::from(*source))
                .collect(),
        ),
    );
    result.insert(
        "observation_updates".to_string(),
        json!(prepared.observation_updates),
    );
    result.insert("output".to_string(), Value::Object(output));
    result.insert(
        "recovery".to_string(),
        json!({ "prepared_decision_apply_count": apply_count }),
    );

    Evaluated {
        result: Value::Object(result),
        emitted,
    }
}

#[test]
fn tst_filter_002_hold_dedup_and_safe_copy() {
    let vector = read_vector("TST-FILTER-002-hold-dedup-and-safe-copy");
    assert_eq!(vector["test_id"], "TST-FILTER-002");
    assert_eq!(
        vector["expected"]["crash_label"],
        "filter.prepared_decision.after_fsync"
    );
    let evaluated = evaluate_tst_filter_002(&vector);
    check_assertions(&evaluated.result, &vector);
    check_emitted(&evaluated.emitted, &vector);
}