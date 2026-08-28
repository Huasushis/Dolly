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
use dolly_protocol::FrameLimits;
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
    let admitted = dolly_extension_host::admit_activation(
        &dispatch.premise,
        &dispatch.result,
        FrameLimits::defaults(),
    )
    .expect("accepted G1 dispatch must pass Host admission");
    let premise = &dispatch.premise;
    let admitted_manifest =
        serde_json::to_value(admitted.manifest()).expect("admitted manifest must serialize");
    assert_eq!(admitted_manifest, dispatch.manifest);
    assert_eq!(admitted.activation_id(), premise.identity().activation_id());
    assert_eq!(
        admitted.activation_id(),
        context["activation_id"].as_str().expect("activation_id context")
    );
    assert_eq!(admitted.module_id(), premise.identity().module_id());
    assert_eq!(
        admitted.module_id(),
        context["module_id"].as_str().expect("module_id context")
    );
    assert_eq!(admitted.request_id(), premise.fence().request_id());
    assert_eq!(
        admitted.request_id(),
        context["request_id"].as_str().expect("request_id context")
    );
    assert_eq!(admitted.reservation_id(), premise.fence().reservation_id());
    assert_eq!(admitted.lease_id(), premise.fence().lease_id());
    assert_eq!(admitted.worker_epoch(), premise.fence().worker_epoch());
    assert_eq!(
        admitted.worker_epoch().to_string(),
        context["worker_epoch"].as_str().expect("worker_epoch context")
    );
    assert_eq!(
        admitted.worker_epoch_fence(),
        premise.fence().worker_epoch_fence()
    );
    assert_eq!(
        admitted.worker_epoch_fence(),
        context["worker_epoch_fence"]
            .as_i64()
            .expect("worker_epoch_fence context")
    );
    assert_eq!(
        admitted.incarnation_revision(),
        premise.fence().incarnation_revision()
    );
    assert_eq!(
        admitted.incarnation_revision(),
        context["host_incarnation"]["incarnation_revision"]
            .as_i64()
            .expect("incarnation_revision context")
    );
    assert_eq!(
        admitted.extension_connection_id(),
        premise.fence().extension_connection_id()
    );
    assert_eq!(
        admitted.extension_connection_id(),
        context["host_incarnation"]["extension_connection_id"]
            .as_str()
            .expect("extension_connection_id context")
    );
    assert_eq!(
        admitted.extension_generation(),
        premise.fence().extension_generation()
    );
    assert_eq!(
        admitted.extension_generation(),
        context["extension_generation"]
            .as_i64()
            .expect("extension_generation context")
    );
    assert_eq!(admitted.lease_generation(), premise.fence().lease_generation());
    assert_eq!(
        admitted.lease_generation(),
        context["lease_generation"]
            .as_i64()
            .expect("lease_generation context")
    );
    assert_eq!(admitted.attempt(), premise.fence().attempt());
    let fixture_token: LeaseToken = source["lease_token"]
        .as_str()
        .expect("lease token")
        .parse()
        .expect("fixture lease token is valid");
    let expected_token_digest =
        Sha256Digest::compute(fixture_token.expose_bytes()).to_canonical_string();
    assert_eq!(
        admitted.lease_token_digest().to_string(),
        expected_token_digest
    );
    assert_eq!(
        admitted.graph_digest().to_string(),
        premise.digests().graph_digest()
    );
    assert_eq!(
        admitted.graph_digest().to_string(),
        canonical_digest(&graph_snapshot(premise.identity().module_id()))
    );
    assert_eq!(
        admitted.descriptor_digest().to_string(),
        premise.digests().descriptor_digest()
    );
    assert_eq!(
        admitted.descriptor_digest().to_string(),
        canonical_digest(&descriptor(premise.identity().module_id()))
    );
    assert_eq!(
        admitted.manifest_digest().to_string(),
        premise.digests().manifest_digest()
    );
    assert_eq!(
        admitted.manifest_digest().to_string(),
        dispatch.manifest["manifest_digest"]
            .as_str()
            .expect("manifest digest")
    );
    assert_eq!(
        admitted.effective_config_digest().to_string(),
        premise.digests().effective_config_digest()
    );
    assert_eq!(
        admitted.effective_config_digest().to_string(),
        canonical_digest(&dispatch.manifest["effective_config"])
    );
    assert_eq!(
        admitted.effective_config_schema_digest().to_string(),
        premise.digests().effective_config_schema_digest()
    );
    assert_eq!(
        admitted.effective_config_schema_digest().to_string(),
        dispatch.manifest["effective_config_schema_digest"]
            .as_str()
            .expect("effective config schema digest")
    );
    assert_eq!(
        admitted.manifest().graph_revision.value(),
        dispatch.manifest["graph_revision"]
            .as_u64()
            .expect("graph revision")
    );
    assert_eq!(
        admitted.manifest().config_revision.value(),
        dispatch.manifest["config_revision"]
            .as_u64()
            .expect("config revision")
    );
    assert_eq!(
        admitted.manifest().descriptor_revision.value(),
        dispatch.manifest["descriptor_revision"]
            .as_u64()
            .expect("descriptor revision")
    );
    assert_eq!(
        admitted.frame_digest().to_string(),
        dispatch.result.frame_digest()
    );
    assert_eq!(
        admitted.frame_digest().to_string(),
        context["frame_digest"].as_str().expect("frame digest context")
    );
    assert_eq!(admitted.order(), premise.order());
    assert_eq!(admitted.replay_scope(), premise.replay_scope());

    let capability_digest = admitted.manifest_digest().to_string();
    let projection = dolly_extension_host::CapabilityProjection::new(
        "org.example.extension",
        admitted.module_id(),
        &capability_digest,
        vec!["host.block.get".into()],
    )
    .expect("Host capability projection");
    let capability = dolly_extension_host::CapabilityRequest::new(
        "org.example.extension",
        admitted.module_id(),
        &capability_digest,
        "host.block.get",
        dolly_extension_host::RpcDirection::ExtensionToHost,
    )
    .expect("Host capability request");
    dolly_extension_host::admit_capability(&projection, &capability)
        .expect("bound capability must pass Host admission");
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
