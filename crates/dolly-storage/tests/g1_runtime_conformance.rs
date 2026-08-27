//! External G1 Runtime transaction conformance.
//!
//! The execution premise is the complete `module.activate` JSON-RPC request
//! that G1 permits after the durable `started` marker. It carries the frozen
//! Manifest and lease bindings; it is not a second authority. This suite stops
//! at that boundary and never invokes an effect consumer.
//!
//! Malformed, reversed, unrelated, and cross-extension neighbor premises are
//! intentionally referenced rather than repeated here. Their accepted
//! reducer boundary is frozen by the cases named in the matrix fixture.

use dolly_canonical_json::canonicalize;
use dolly_core_reducer::{
    ActivationState, BuildManifestCommand, CoreCommand, DispatchLeaseCommand, DispatchState,
    EnvironmentInput, InstallGraphCommand, IssueLeaseCommand, TransitionOutcome,
};
use dolly_storage::SqliteCoreStore;
use rusqlite::Connection;
use serde_json::{Value, json};

const MATRIX: &str = include_str!("fixtures/g1_runtime_conformance.json");

fn matrix() -> Value {
    serde_json::from_str(MATRIX).expect("G1 matrix fixture must be valid JSON")
}

fn case(id: &str) -> Value {
    matrix()["cases"]
        .as_array()
        .expect("G1 matrix cases must be an array")
        .iter()
        .find(|candidate| candidate["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("G1 matrix case {id} is missing"))
}

fn canonical_digest(value: &Value) -> String {
    canonicalize(value)
        .expect("fixture value must be canonical JSON")
        .1
        .to_canonical_string()
}

fn input() -> EnvironmentInput {
    EnvironmentInput {
        now: "2026-08-27T00:00:00.000000Z".into(),
        ..Default::default()
    }
}

fn graph_input() -> EnvironmentInput {
    EnvironmentInput {
        graph_revision: Some(1),
        descriptor_revision: Some(1),
        ..input()
    }
}

fn graph_snapshot(module_id: &str) -> Value {
    json!({
        "receiving_module": module_id,
        "input_pages": {},
        "output_pages": {},
        "subscriptions": {},
        "descriptors": {},
        "authorized_metadata_namespaces": [],
        "authorized_action_names": []
    })
}

fn install_graph(store: &mut SqliteCoreStore<'_>, module_id: &str, command_id: &str) {
    let graph = graph_snapshot(module_id);
    let command = CoreCommand::InstallGraph(InstallGraphCommand {
        command_id: command_id.into(),
        revision: 1,
        digest: canonical_digest(&graph),
        graph,
    });
    let transition = store
        .transact(&command, &input())
        .expect("graph transaction must execute");
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
}

fn manifest(
    case: &Value,
    neighbors: Value,
    graph_revision: i64,
    descriptor_revision: i64,
) -> Value {
    let mut manifest = json!({
        "schema": "dolly.activation-manifest/v1",
        "activation_id": case["activation_id"],
        "module_id": case["module_id"],
        "reason": "timer",
        "created_at": "2026-08-27T00:00:00.000000Z",
        "graph_revision": graph_revision,
        "config_revision": 1,
        "descriptor_revision": descriptor_revision,
        "effective_config": {
            "execution_timeout_ms": 120000,
            "lease_grace_ms": 30000,
            "fencing_grace_ms": 5000
        },
        "effective_config_digest": null,
        "effective_config_schema_digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "input_items": [],
        "cursor_spans": [],
        "lossy_gaps": [],
        "output_page_ids": [],
        "neighbor_descriptors": neighbors,
        "required_frame_bytes": 1024,
        "required_frame_nesting_depth": 10,
        "deadline": "2026-08-27T00:02:00.000000Z",
        "manifest_digest": null
    });
    let effective_config_digest = canonical_digest(&manifest["effective_config"]);
    manifest["effective_config_digest"] = json!(effective_config_digest);
    let mut digestable = manifest.clone();
    digestable
        .as_object_mut()
        .expect("manifest must be an object")
        .remove("manifest_digest");
    manifest["manifest_digest"] = json!(canonical_digest(&digestable));
    manifest
}

fn build_command(
    case: &Value,
    command_id: &str,
    neighbors: Value,
    graph_revision: i64,
    descriptor_revision: i64,
) -> CoreCommand {
    CoreCommand::BuildManifest(BuildManifestCommand {
        command_id: command_id.into(),
        activation_id: case["activation_id"]
            .as_str()
            .expect("activation_id must be a string")
            .into(),
        manifest: manifest(case, neighbors, graph_revision, descriptor_revision),
        expected_graph_revision: Some(graph_revision),
        expected_descriptor_revision: Some(descriptor_revision),
    })
}

fn issue_command(case: &Value, command_id: &str, lease_id: &str) -> CoreCommand {
    CoreCommand::IssueLease(IssueLeaseCommand {
        command_id: command_id.into(),
        activation_id: case["activation_id"]
            .as_str()
            .expect("activation_id must be a string")
            .into(),
        lease_id: lease_id.into(),
        token_digest: case["token_digest"]
            .as_str()
            .expect("token_digest must be a string")
            .into(),
        extension_connection_id: "g1-extension-connection".into(),
        worker_epoch: 17,
        extension_generation: Some(7),
    })
}

fn expected_module_activate(case: &Value, manifest: Value) -> Value {
    let mut expected = case["expected_request"].clone();
    expected["params"]["manifest"] = manifest;
    expected
}

#[test]
fn g1_exec_001_valid_durable_activation_emits_exact_module_activate_premise_before_effect() {
    let case = case("G1-EXEC-001");
    assert_eq!(case["expected"], "product_red");
    let activation_id = case["activation_id"].as_str().unwrap();
    let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
    let mut store = SqliteCoreStore::new(&mut connection).expect("core schema");
    install_graph(
        &mut store,
        case["module_id"].as_str().unwrap(),
        "g1-exec-graph-001",
    );

    let build = build_command(&case, "g1-exec-build-001", json!([]), 1, 1);
    let manifest = match &build {
        CoreCommand::BuildManifest(command) => command.manifest.clone(),
        _ => unreachable!("build command shape"),
    };
    let built = store
        .transact(&build, &graph_input())
        .expect("accepted manifest transaction");
    assert_eq!(built.outcome, TransitionOutcome::Committed);

    let issue = issue_command(&case, "g1-exec-lease-001", "g1-exec-lease-id-001");
    let leased = store
        .transact(&issue, &input())
        .expect("accepted lease transaction");
    assert_eq!(leased.outcome, TransitionOutcome::Committed);
    assert_eq!(
        leased.state.activations[activation_id].state,
        ActivationState::Leased
    );
    assert_eq!(
        leased.state.activations[activation_id].extension_generation,
        Some(7)
    );

    let dispatch = CoreCommand::DispatchLease(DispatchLeaseCommand {
        command_id: "g1-exec-dispatch-001".into(),
        activation_id: activation_id.into(),
        lease_id: "g1-exec-lease-id-001".into(),
        dispatch_state: DispatchState::Started,
    });
    let started = store
        .transact(&dispatch, &input())
        .expect("accepted durable dispatch marker");
    assert_eq!(started.outcome, TransitionOutcome::Committed);
    assert_eq!(
        started.state.activations[activation_id].state,
        ActivationState::Dispatched
    );
    assert_eq!(
        started.state.leases["g1-exec-lease-id-001"]["dispatch_state"],
        "started"
    );

    // The effect boundary is deliberately not entered by this matrix.
    let effect_consumer_calls = 0;
    assert_eq!(effect_consumer_calls, case["effect_consumer_calls"]);

    // G1 requires the complete canonical request, not merely a lease or marker.
    // The accepted WP base has no emitted request at this boundary; this exact
    // assertion is the deterministic product RED for the missing capability.
    assert_eq!(
        started.reply,
        Some(expected_module_activate(&case, manifest)),
        "G1 dispatch must emit the exact module.activate execution premise"
    );
}
