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

use dolly_canonical_json::{Sha256Digest, canonicalize};
use dolly_core_domain::LeaseToken;
use dolly_core_reducer::{
    ActivationState, BuildManifestCommand, CoreCommand, EnvironmentInput, InstallConfigCommand,
    InstallGraphCommand, TransitionOutcome,
};
use dolly_runtime::{LeaseRequest, RuntimeTransactionEngine};
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

fn descriptor(module_id: &str) -> Value {
    json!({
        "schema": "dolly.module-descriptor/v1",
        "module_id": module_id,
        "descriptor_revision": 1,
        "display_name": module_id,
        "accepts": {"summary":"input","part_kinds":["text"],"action_names":[]},
        "emits": {"summary":"output","part_kinds":["text"],"action_names":[]},
        "actions": [],
        "activation_replay_contract": {
            "mode":"fenced_replay",
            "evidence":"pure_compute",
            "ledger":null
        },
        "trust": "trusted",
        "metadata": {}
    })
}

fn graph_snapshot(module_id: &str) -> Value {
    let descriptor = descriptor(module_id);
    let mut descriptors = serde_json::Map::new();
    descriptors.insert(
        module_id.into(),
        json!({
            "module_id": module_id,
            "descriptor_revision": 1,
            "source_descriptor_digest": canonical_digest(&descriptor),
            "value": descriptor
        }),
    );
    json!({
        "receiving_module": module_id,
        "input_pages": {},
        "output_pages": {},
        "subscriptions": {},
        "descriptors": descriptors,
        "authorized_metadata_namespaces": [],
        "authorized_action_names": []
    })
}

fn install_config(store: &mut SqliteCoreStore<'_>) {
    let effective_config = json!({
        "execution_timeout_ms": 120000,
        "lease_grace_ms": 30000,
        "fencing_grace_ms": 5000,
        "extension_connection_id": "g1-extension-connection",
        "worker_epoch": "0198ab31-6c44-7e8a-b2bb-000000000110",
        "worker_epoch_fence": 17
    });
    let command = CoreCommand::InstallConfig(InstallConfigCommand {
        command_id: "g1-exec-config-001".into(),
        revision: 1,
        digest: canonical_digest(&effective_config),
        effective_config,
    });
    let transition = store
        .transact(&command, &input())
        .expect("configuration transaction must execute");
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
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
            "fencing_grace_ms": 5000,
            "extension_connection_id": "g1-extension-connection",
            "worker_epoch": "0198ab31-6c44-7e8a-b2bb-000000000110",
            "worker_epoch_fence": 17
        },
        "effective_config_digest": null,
        "effective_config_schema_digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "input_items": [],
        "cursor_spans": [],
        "lossy_gaps": [],
        "output_page_ids": [],
        "neighbor_descriptors": neighbors,
        "required_frame_bytes": 2048,
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

fn issue_command(
    case: &Value,
    command_id: &str,
    lease_id: &str,
    token_digest: &str,
) -> LeaseRequest {
    LeaseRequest::new(
        command_id,
        case["activation_id"]
            .as_str()
            .expect("activation_id must be a string"),
        lease_id,
        token_digest,
        Some(7),
    )
}

fn expected_module_activate(case: &Value, manifest: Value, request_id: &str) -> Value {
    let mut expected = case["expected_request"].clone();
    expected["id"] = json!(request_id);
    expected["params"]["manifest"] = manifest;
    expected
}

#[test]
fn g1_exec_001_valid_durable_activation_emits_exact_module_activate_premise_before_effect() {
    let case = case("G1-EXEC-001");
    assert_eq!(case["expected"], "product_red");
    let activation_id = case["activation_id"].as_str().unwrap();
    let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
    {
        let mut store = SqliteCoreStore::new(&mut connection).expect("core schema");
        install_config(&mut store);
        install_graph(
            &mut store,
            case["module_id"].as_str().unwrap(),
            "g1-exec-graph-001",
        );
    }
    let mut engine = RuntimeTransactionEngine::new(&mut connection).expect("runtime engine");

    let build = build_command(&case, "g1-exec-build-001", json!([]), 1, 1);
    let manifest = match &build {
        CoreCommand::BuildManifest(command) => command.manifest.clone(),
        _ => unreachable!("build command shape"),
    };
    let built = engine
        .accept_manifest(
            match &build {
                CoreCommand::BuildManifest(command) => command,
                _ => unreachable!("build command shape"),
            },
            &graph_input(),
        )
        .expect("accepted manifest transaction");
    assert_eq!(built.outcome, TransitionOutcome::Committed);

    let lease_token: LeaseToken = case["lease_token"]
        .as_str()
        .unwrap()
        .parse()
        .expect("fixture lease token");
    let token_digest =
        Sha256Digest::compute(lease_token.expose_bytes()).to_canonical_string();
    let issue = issue_command(
        &case,
        "g1-exec-lease-001",
        "g1-exec-lease-id-001",
        &token_digest,
    );
    let reservation = engine
        .allocate_request(&issue, &graph_input())
        .expect("allocated Host request reservation");
    let premise = engine
        .prepare_execution(&issue, &reservation, &graph_input())
        .expect("accepted lease transaction");
    assert!(!premise.fence().request_id().is_empty());
    assert!(premise.fence().request_id().len() <= 128);
    let leased = engine.snapshot().expect("durable lease snapshot");
    assert_eq!(
        leased.activations[activation_id].state,
        ActivationState::Leased
    );
    assert_eq!(
        leased.activations[activation_id].extension_generation,
        Some(7)
    );
    let dispatched = engine
        .dispatch_execution(
            &premise,
            "g1-exec-dispatch-001",
            &lease_token,
            &input(),
        )
        .expect("accepted durable dispatch marker");
    let started = dispatched.transition();
    assert_eq!(started.outcome, TransitionOutcome::Committed);
    assert_eq!(
        started.state.activations[activation_id].state,
        ActivationState::Dispatched
    );
    assert_eq!(
        started.state.leases["g1-exec-lease-id-001"]["dispatch_state"],
        "started"
    );

    let expected = expected_module_activate(&case, manifest, premise.fence().request_id());
    let observed: Value =
        serde_json::from_slice(dispatched.frame_bytes()).expect("canonical frame JSON");
    assert_eq!(observed, expected);
    let (canonical_frame, _) = canonicalize(&observed).expect("canonical frame");
    assert_eq!(canonical_frame.as_bytes(), dispatched.frame_bytes());
    assert_eq!(
        started.state.leases["g1-exec-lease-id-001"]["worker_epoch_id"],
        case["worker_epoch"]
    );
    assert_eq!(
        started.state.leases["g1-exec-lease-id-001"]["request_id"],
        premise.fence().request_id()
    );
    assert_eq!(
        started.state.leases["g1-exec-lease-id-001"]["extension_connection_id"],
        "g1-extension-connection"
    );
    assert_eq!(
        started.state.leases["g1-exec-lease-id-001"]["reservation_id"],
        premise.fence().reservation_id()
    );
    assert_eq!(dispatched.frame_digest(), canonical_digest(&expected));
    assert_eq!(
        started.state.leases["g1-exec-lease-id-001"]["frame_digest"],
        dispatched.frame_digest()
    );
    assert!(started.reply.is_none());
    let replayed = engine
        .dispatch_execution(
            &premise,
            "g1-exec-dispatch-replay-001",
            &lease_token,
            &input(),
        )
        .expect("same request reservation must replay");
    assert_eq!(replayed.frame_bytes(), dispatched.frame_bytes());
    assert_eq!(replayed.frame_digest(), dispatched.frame_digest());
    assert_eq!(replayed.transition().state, started.state);
    assert!(replayed.transition().events.is_empty());
    let durable = engine.snapshot().unwrap();
    assert_eq!(
        durable.leases["g1-exec-lease-id-001"]["frame_digest"],
        dispatched.frame_digest()
    );
    let journal_event = durable
        .journal
        .iter()
        .find(|event| event.command_id == "g1-exec-dispatch-001")
        .expect("durable dispatch journal event");
    assert_eq!(
        journal_event.details.as_ref().unwrap()["frame_digest"],
        dispatched.frame_digest()
    );
    assert_eq!(
        journal_event.details.as_ref().unwrap()["request_id"],
        premise.fence().request_id()
    );
    assert_eq!(
        journal_event.details.as_ref().unwrap()["extension_connection_id"],
        "g1-extension-connection"
    );

    // The effect boundary is deliberately not entered by this matrix.
    let effect_consumer_calls = 0;
    assert_eq!(effect_consumer_calls, case["effect_consumer_calls"]);
}
