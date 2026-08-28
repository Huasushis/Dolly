//! External G2 Extension Host and software development kit (SDK) admission
//! conformance.
//!
//! The invocation context is the one object handed from the committed G1
//! frame/premise to the Host: immutable identity and fence data plus one
//! canonical `module.activate` request. This suite stops before Extension code
//! and effect semantics. The two hostile inputs reference accepted capability
//! controls instead of repeating them here.

use dolly_canonical_json::{Sha256Digest, canonicalize};
use dolly_core_domain::LeaseToken;
use dolly_core_reducer::{
    ActivationState, BuildManifestCommand, CoreCommand, EnvironmentInput, InstallConfigCommand,
    InstallGraphCommand, TransitionOutcome,
};
use dolly_runtime::{DispatchResult, ExecutionPremise, LeaseRequest, RuntimeTransactionEngine};
use dolly_storage::SqliteCoreStore;
use rusqlite::Connection;
use serde_json::{Value, json};

const G1_MATRIX: &str = include_str!("fixtures/g1_runtime_conformance.json");
const G2_MATRIX: &str = include_str!("fixtures/g2_extension_host_sdk_conformance.json");

fn matrix() -> Value {
    serde_json::from_str(G2_MATRIX).expect("G2 matrix fixture must be valid JSON")
}

fn case(id: &str) -> Value {
    matrix()["cases"]
        .as_array()
        .expect("G2 matrix cases must be an array")
        .iter()
        .find(|candidate| candidate["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("G2 matrix case {id} is missing"))
}

fn g1_case(id: &str) -> Value {
    let document: Value =
        serde_json::from_str(G1_MATRIX).expect("accepted G1 matrix fixture must be valid JSON");
    document["cases"]
        .as_array()
        .expect("accepted G1 matrix cases must be an array")
        .iter()
        .find(|candidate| candidate["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("accepted G1 matrix case {id} is missing"))
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
        "activation_replay_contract": {"mode":"fenced_replay","evidence":"pure_compute","ledger":null},
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
    let transition = store
        .transact(
            &CoreCommand::InstallConfig(InstallConfigCommand {
                command_id: "g2-exec-config-001".into(),
                revision: 1,
                digest: canonical_digest(&effective_config),
                effective_config,
            }),
            &input(),
        )
        .expect("configuration transaction must execute");
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    store
        .bootstrap_host_connection()
        .expect("Host connection bootstrap");
}

fn install_graph(store: &mut SqliteCoreStore<'_>, module_id: &str) {
    let graph = graph_snapshot(module_id);
    let transition = store
        .transact(
            &CoreCommand::InstallGraph(InstallGraphCommand {
                command_id: "g2-exec-graph-001".into(),
                revision: 1,
                digest: canonical_digest(&graph),
                graph,
            }),
            &graph_input(),
        )
        .expect("graph transaction must execute");
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
}

fn manifest(case: &Value) -> Value {
    let mut manifest = json!({
        "schema": "dolly.activation-manifest/v1",
        "activation_id": case["activation_id"],
        "module_id": case["module_id"],
        "reason": "timer",
        "created_at": "2026-08-27T00:00:00.000000Z",
        "graph_revision": 1,
        "config_revision": 1,
        "descriptor_revision": 1,
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
        "neighbor_descriptors": [],
        "required_frame_bytes": 2048,
        "required_frame_nesting_depth": 10,
        "deadline": "2026-08-27T00:02:00.000000Z",
        "manifest_digest": null
    });
    manifest["effective_config_digest"] = json!(canonical_digest(&manifest["effective_config"]));
    let mut digestable = manifest.clone();
    digestable
        .as_object_mut()
        .expect("manifest must be an object")
        .remove("manifest_digest");
    manifest["manifest_digest"] = json!(canonical_digest(&digestable));
    manifest
}

fn build_command(case: &Value) -> BuildManifestCommand {
    BuildManifestCommand {
        command_id: "g2-exec-build-001".into(),
        activation_id: case["activation_id"]
            .as_str()
            .expect("activation_id must be a string")
            .into(),
        manifest: manifest(case),
        expected_graph_revision: Some(1),
        expected_descriptor_revision: Some(1),
    }
}

fn issue_command(case: &Value, token_digest: &str) -> LeaseRequest {
    LeaseRequest::new(
        "g2-exec-lease-001",
        case["activation_id"]
            .as_str()
            .expect("activation_id must be a string"),
        "g2-exec-lease-id-001",
        token_digest,
        Some(7),
    )
}

struct G1Dispatch {
    premise: ExecutionPremise,
    result: DispatchResult,
    manifest: Value,
}

fn dispatch_g1_case(case: &Value) -> G1Dispatch {
    let activation_id = case["activation_id"]
        .as_str()
        .expect("G1 activation_id must be a string");
    let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
    {
        let mut store = SqliteCoreStore::new(&mut connection).expect("core schema");
        install_config(&mut store);
        install_graph(
            &mut store,
            case["module_id"]
                .as_str()
                .expect("G1 module_id must be a string"),
        );
    }
    let mut engine = RuntimeTransactionEngine::new(&mut connection).expect("runtime engine");
    let build = build_command(case);
    let manifest = build.manifest.clone();
    let built = engine
        .accept_manifest(&build, &graph_input())
        .expect("accepted manifest transaction");
    assert_eq!(built.outcome, TransitionOutcome::Committed);
    let lease_token: LeaseToken = case["lease_token"]
        .as_str()
        .expect("fixture lease token")
        .parse()
        .expect("fixture lease token is valid");
    let token_digest = Sha256Digest::compute(lease_token.expose_bytes()).to_canonical_string();
    let issue = issue_command(case, &token_digest);
    let reservation = engine
        .allocate_request(&issue, &graph_input())
        .expect("allocated Host request reservation");
    let premise = engine
        .prepare_execution(&issue, &reservation, &graph_input())
        .expect("accepted lease transaction");
    let result = engine
        .dispatch_execution(&premise, "g2-exec-dispatch-001", &lease_token, &input())
        .expect("accepted durable dispatch marker");
    assert_eq!(
        result.transition().state.activations[activation_id].state,
        ActivationState::Dispatched
    );
    G1Dispatch {
        premise,
        result,
        manifest,
    }
}

fn frame(dispatch: &G1Dispatch) -> Value {
    serde_json::from_slice(dispatch.result.frame_bytes()).expect("canonical frame JSON")
}

fn invocation_context(dispatch: &G1Dispatch) -> Value {
    let frame = frame(dispatch);
    let manifest = &frame["params"]["manifest"];
    let fence = dispatch.premise.fence();
    json!({
        "activation_id": dispatch.premise.identity().activation_id(),
        "module_id": dispatch.premise.identity().module_id(),
        "worker_epoch": fence.worker_epoch().to_string(),
        "worker_epoch_fence": fence.worker_epoch_fence(),
        "extension_generation": fence.extension_generation(),
        "lease_generation": fence.lease_generation(),
        "manifest_digest": dispatch.premise.digests().manifest_digest(),
        "graph_revision": manifest["graph_revision"],
        "frame_digest": dispatch.result.frame_digest(),
        "request_id": fence.request_id(),
        "host_incarnation": {
            "extension_connection_id": fence.extension_connection_id(),
            "worker_epoch": fence.worker_epoch().to_string(),
            "incarnation_revision": fence.incarnation_revision()
        }
    })
}

#[test]
fn g2_admission_001_valid_committed_g1_module_activate_reaches_one_host_admission_request() {
    let admission_case = case("G2-ADMISSION-001");
    assert_eq!(admission_case["expected"], "product_red");
    let source = g1_case(admission_case["source_case"].as_str().expect("source case"));
    let dispatch = dispatch_g1_case(&source);
    let observed = frame(&dispatch);
    let fence = dispatch.premise.fence();
    let mut expected = source["expected_request"].clone();
    expected["id"] = json!(fence.request_id());
    expected["params"]["manifest"] = dispatch.manifest.clone();
    assert_eq!(observed, expected);
    assert_eq!(canonical_digest(&observed), dispatch.result.frame_digest());

    let context = invocation_context(&dispatch);
    assert_eq!(
        context["activation_id"],
        json!(dispatch.premise.identity().activation_id())
    );
    assert_eq!(
        context["module_id"],
        json!(dispatch.premise.identity().module_id())
    );
    assert_eq!(context["worker_epoch"], fence.worker_epoch().to_string());
    assert_eq!(
        context["worker_epoch_fence"],
        json!(fence.worker_epoch_fence())
    );
    assert_eq!(
        context["extension_generation"],
        json!(fence.extension_generation())
    );
    assert_eq!(context["lease_generation"], json!(fence.lease_generation()));
    assert_eq!(
        context["manifest_digest"],
        dispatch.premise.digests().manifest_digest()
    );
    assert_eq!(
        context["manifest_digest"],
        dispatch.manifest["manifest_digest"]
    );
    assert_eq!(
        context["graph_revision"],
        dispatch.manifest["graph_revision"]
    );
    assert_eq!(context["frame_digest"], dispatch.result.frame_digest());
    assert_eq!(context["frame_digest"], canonical_digest(&observed));
    assert_eq!(context["request_id"], fence.request_id());
    assert_eq!(context["request_id"], observed["id"]);
    assert_eq!(
        context["host_incarnation"]["extension_connection_id"],
        fence.extension_connection_id()
    );
    assert_eq!(
        context["host_incarnation"]["worker_epoch"],
        fence.worker_epoch().to_string()
    );
    assert_eq!(
        context["host_incarnation"]["incarnation_revision"],
        json!(fence.incarnation_revision())
    );

    let state = &dispatch.result.transition().state;
    assert!(state.outputs.is_empty(), "admission must not append output");
    assert!(
        state.deliveries.is_empty(),
        "admission must not deliver output"
    );
    assert!(state.pages.is_empty(), "admission must not append a Page");
    assert!(
        state.blocks.is_empty(),
        "admission must not publish a Block"
    );
    let receipt = dispatch
        .result
        .transition()
        .reply
        .as_ref()
        .and_then(|reply| reply.get("host_admission"))
        .expect("G2-ADMISSION-001: committed module.activate frame has no Host admission receipt");
    assert_eq!(receipt["method"], "module.activate");
    assert_eq!(receipt["context"], context);
    assert_eq!(receipt["request"], observed);
}

#[test]
fn g2_minimum_fail_closed_controls_remain_referenced() {
    for id in [
        "G2-AUTHORITY-UNDECLARED-CAPABILITY",
        "G2-AUTHORITY-CROSS-EXTENSION",
    ] {
        let control = case(id);
        assert_eq!(control["expected"], "pass");
        let references = control["references"]
            .as_array()
            .expect("fail-closed control must reference an existing test");
        assert_eq!(references.len(), 1);
        assert!(references[0].as_str().is_some());
    }
}
