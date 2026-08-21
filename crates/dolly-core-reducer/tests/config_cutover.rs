//! Conformance test for the old-manifest graph cutover vector
//! (TST-CONFIG-001, INV-CFG-003 / INV-ROUTE-001).
//!
//! The control-plane spec (docs/spec/control-plane/01, sections 6-7) defines:
//! an Activation manifest records the exact graph revision used to select
//! inputs and route its result; after the active graph pointer advances, an
//! already persisted Activation owns its old snapshot and MAY commit after
//! cutover — its output goes only to the old frozen Page set, never to the new
//! graph. The ActivationCommitted event must carry the manifest's
//! `graph_revision`, never the active graph revision read at result time, so a
//! downstream observer cannot reverse-authorize a newer graph.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use dolly_canonical_json::canonicalize;
use dolly_core_reducer::*;
use serde_json::{Map, Value, json};

fn spec_root() -> PathBuf {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../dolly-spec");
    Path::new(path).to_path_buf()
}
fn read_vector() -> Value {
    serde_json::from_slice(
        &fs::read(spec_root().join("test-vectors/config/TST-CONFIG-001-old-manifest-cutover.json"))
            .unwrap(),
    )
    .unwrap()
}
fn digest(value: &Value) -> String {
    canonicalize(value).unwrap().1.to_canonical_string()
}
fn base_input() -> EnvironmentInput {
    EnvironmentInput {
        now: "2026-08-21T00:00:00.000000Z".into(),
        ..Default::default()
    }
}
fn reduce_with(state: &CoreSnapshot, command: CoreCommand) -> Transition {
    reduce(state, &command, &base_input())
}
fn flatten(event: &CoreEvent) -> Value {
    let mut map = Map::new();
    map.insert("event".into(), json!(event.event));
    if let Some(details) = event.details.as_ref().and_then(Value::as_object) {
        for (key, value) in details {
            map.insert(key.clone(), value.clone());
        }
    }
    Value::Object(map)
}
fn staged(
    id: &str,
    cursors: BTreeMap<String, i64>,
    outputs: Vec<Value>,
    pages: BTreeMap<String, Vec<PageRecord>>,
    projected: i64,
    limit: Option<i64>,
) -> CoreSnapshot {
    let mut state = empty_core_snapshot();
    state.activations.insert(
        id.into(),
        ActivationRecord {
            state: ActivationState::ResultStaged,
            attempt: 1,
            result_digest: Some(
                "sha256:4444444444444444444444444444444444444444444444444444444444444444".into(),
            ),
            authoritative_disposition: Some(ActivationState::ResultStaged),
            staged_result: Some(StagedResult {
                expected_cursors: cursors,
                outputs,
                admitted_pages: pages,
                projected_admission_entries: projected,
                page_limit: limit,
                validation: None,
            }),
            ..Default::default()
        },
    );
    state
}
fn subset(actual: &Value, required: &Value) -> bool {
    match required {
        Value::Object(map) => map.iter().all(|(key, value)| {
            actual
                .get(key)
                .is_some_and(|candidate| subset(candidate, value))
        }),
        Value::Array(items) => actual.as_array().is_some_and(|array| {
            array.len() == items.len() && array.iter().zip(items).all(|(a, b)| subset(a, b))
        }),
        _ => actual == required,
    }
}
fn count(value: &Value) -> Option<usize> {
    match value {
        Value::Array(array) => Some(array.len()),
        Value::Object(map) => Some(map.len()),
        Value::String(text) => Some(text.len()),
        _ => None,
    }
}

/// Graph revision admission keeps its optimistic-conflict precedence: an
/// install at or below the active revision rejects with
/// `GRAPH_REVISION_CONFLICT`, and the active snapshot is left untouched.
#[test]
fn graph_revision_conflict_precedence_survives_cutover() {
    let mut state = empty_core_snapshot();
    state.graph = json!({"revision": 7});
    for stale_revision in [7, 6] {
        let graph = json!({"output_pages":["new-output"]});
        let result = reduce_with(
            &state,
            CoreCommand::InstallGraph(InstallGraphCommand {
                command_id: format!("install-{stale_revision}"),
                revision: stale_revision,
                graph: graph.clone(),
                digest: digest(&graph),
            }),
        );
        let error = result.error.as_ref().expect("rejected");
        assert_eq!(error.code, "GRAPH_REVISION_CONFLICT");
        assert_eq!(result.state.graph, state.graph, "snapshot untouched");
        assert!(result.events.is_empty(), "no event emitted on conflict");
    }
}

#[test]
fn tst_config_001_old_manifest_survives_graph_cutover() {
    let vector = read_vector();
    assert_eq!(vector["schema"], "dolly.test-vector/v1");
    assert_eq!(vector["test_id"], "TST-CONFIG-001");
    assert_eq!(vector["kind"], "config");
    assert_eq!(
        vector["expected"]["outcome"],
        "old_manifest_commits_to_old_snapshot"
    );
    assert_eq!(vector["expected"]["crash_label"], Value::Null);
    let expected_emitted = vector["expected"]["emitted"].as_array().unwrap();
    assert_eq!(expected_emitted.len(), 2);
    let initial = &vector["initial"];
    let old_revision = initial["active_graph_revision"].as_i64().unwrap();
    assert_eq!(
        old_revision,
        initial["activation_manifest_revision"].as_i64().unwrap(),
        "activation was created under the old graph"
    );
    let new_revision = initial["candidate_revision"].as_i64().unwrap();

    // ── seed state: in-flight Activation created under old graph ──
    // Its manifest pins graph revision 7 and the frozen output route; its
    // staged result carries deliveries for the old route only.
    let mut state = staged(
        "a",
        BTreeMap::new(),
        vec![json!({
            "block_id":"old-block",
            "block":json!({"text":"old"}),
            "deliveries":[{"block_id":"old-block","page_id":"old-output"}],
        })],
        BTreeMap::new(),
        0,
        None,
    );
    state.graph = json!({"revision": old_revision});
    state.activations.get_mut("a").unwrap().manifest = Some(json!({
        "graph_revision": initial["activation_manifest_revision"],
        "output_pages": initial["manifest_output_pages"],
        "reason": "input",
    }));

    // ── InstallGraph(8): the active graph pointer advances atomically ──
    let install_graph = json!({"output_pages": initial["candidate_output_pages"]});
    let installed = reduce_with(
        &state,
        CoreCommand::InstallGraph(InstallGraphCommand {
            command_id: "install-graph-8".into(),
            revision: new_revision,
            graph: install_graph.clone(),
            digest: digest(&install_graph),
        }),
    );
    assert!(installed.error.is_none(), "install must succeed");
    assert_eq!(
        installed.state.graph["revision"], new_revision,
        "active graph is the installed one"
    );
    let graph_installed = installed
        .events
        .iter()
        .find(|event| event.event == "GraphInstalled")
        .expect("GraphInstalled event")
        .clone();

    // ── ApplyOldManifestResult: old item completes on its old route ──
    let applied = reduce_with(
        &installed.state,
        CoreCommand::ApplyResult(ApplyResultCommand {
            command_id: "apply-old-result".into(),
            activation_id: "a".into(),
        }),
    );
    assert!(applied.error.is_none(), "apply must succeed");
    let activation_committed = applied
        .events
        .iter()
        .find(|event| event.event == "ActivationCommitted")
        .expect("ActivationCommitted event")
        .clone();

    let mut by_page: Map<String, Value> = Map::new();
    by_page.insert("old-output".into(), json!([]));
    by_page.insert("new-output".into(), json!([]));
    for delivery in &applied.state.deliveries {
        let page = delivery["page_id"].as_str().expect("delivery page_id");
        by_page
            .get_mut(page)
            .unwrap_or_else(|| panic!("undeliverable new-graph page {page}"))
            .as_array_mut()
            .unwrap()
            .push(delivery.clone());
    }
    let observed = json!({
        "active_graph_revision": applied.state.graph["revision"],
        "deliveries": by_page,
        "activation":{"state":applied.state.activations["a"].state},
    });
    let emitted = vec![flatten(&graph_installed), flatten(&activation_committed)];
    let events: Vec<Value> = [&installed, &applied]
        .iter()
        .flat_map(|transition| transition.events.iter().map(flatten).collect::<Vec<_>>())
        .collect();

    // ── assert the vector assertions ──
    for assertion in vector["expected"]["assertions"].as_array().unwrap() {
        let actual = observed.pointer(assertion["path"].as_str().unwrap());
        let expected = &assertion["value"];
        match assertion["op"].as_str().unwrap() {
            "equals" => assert_eq!(actual, Some(expected), "{}", assertion["path"]),
            "count" => assert_eq!(
                actual.and_then(count),
                expected.as_u64().map(|value| value as usize),
                "{}",
                assertion["path"]
            ),
            other => panic!("unsupported assertion {other}"),
        }
    }
    assert_eq!(
        events.len(),
        expected_emitted.len(),
        "one event per emitted entry, in order"
    );
    for (actual, required) in events.iter().zip(expected_emitted) {
        assert!(
            subset(actual, required),
            "emitted\nactual={actual}\nrequired={required}"
        );
    }

    // Cross-checks stating the cutover contract directly:
    assert_eq!(
        applied.state.graph["revision"], new_revision,
        "INV-CFG-001/002: active graph advanced once, old snapshot still frozen"
    );
    assert_eq!(
        emitted[1]["graph_revision"], old_revision,
        "INV-ROUTE-001: ActivationCommitted reports the manifest graph revision"
    );
    assert_eq!(
        observed.pointer("/deliveries/new-output").and_then(count),
        Some(0),
        "INV-CFG-003: no output routed into the new graph"
    );
    assert_eq!(
        observed.pointer("/deliveries/old-output").and_then(count),
        Some(1),
        "INV-CFG-003: output stays on the old frozen page set"
    );
}
