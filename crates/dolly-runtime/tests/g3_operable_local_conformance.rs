//! External G3 operable-local substrate conformance.
//!
//! The handoff under test is deliberately smaller than a new authority layer:
//! an accepted G2 invocation context reaches one daemon-supervised local
//! operational premise, then stops before external I/O.
//! The valid boundary is one passing case; the invalid controls point to the accepted G1, G2,
//! and work-package tests instead of repeating them here.

use dolly_canonical_json::{Sha256Digest, canonicalize};
use dolly_core_domain::LeaseToken;
use dolly_core_reducer::{
    ActivationState, BuildManifestCommand, CoreCommand, EnvironmentInput, InstallConfigCommand,
    InstallGraphCommand, TransitionOutcome,
};
use dolly_protocol::FrameLimits;
use dolly_runtime::{DispatchResult, ExecutionPremise, LeaseRequest, RuntimeTransactionEngine};
use dolly_storage::SqliteCoreStore;
use rusqlite::{Connection, types::Value as SqlValue};
use serde_json::{Value, json};

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
        "metadata": {"org.example.extension":{"capabilities":["host.block.get"]}}
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
        "authorized_metadata_namespaces": ["org.example.extension"],
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
            .expect("G1 activation_id must be a string")
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
            .expect("G1 activation_id must be a string"),
        "g2-exec-lease-id-001",
        token_digest,
        Some(7),
    )
}

struct G1Dispatch {
    premise: ExecutionPremise,
    result: DispatchResult,
    lease_token: LeaseToken,
    manifest: Value,
    connection: Connection,
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
    drop(engine);
    {
        let mut store = SqliteCoreStore::new(&mut connection).expect("core schema");
        let authority = store
            .authenticated_host_connection()
            .expect("current Host authority");
        let module_id = premise.identity().module_id();
        store
            .install_host_capability_grant(
                &authority,
                "org.example.extension",
                module_id,
                premise.fence().extension_generation(),
                manifest["descriptor_revision"]
                    .as_i64()
                    .expect("descriptor revision"),
                &canonical_digest(&descriptor(module_id)),
                manifest["config_revision"]
                    .as_i64()
                    .expect("manifest revision"),
                manifest["manifest_digest"]
                    .as_str()
                    .expect("manifest digest"),
                manifest["graph_revision"].as_i64().expect("graph revision"),
                &canonical_digest(&graph_snapshot(module_id)),
                &["host.block.get"],
            )
            .expect("sealed Host capability grant");
    }
    G1Dispatch {
        premise,
        result,
        lease_token,
        manifest,
        connection,
    }
}

fn durable_snapshot(connection: &Connection) -> Vec<(String, Vec<Vec<SqlValue>>)> {
    let table_names = {
        let mut statement = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .expect("durable table listing");
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("durable table query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("durable table names")
    };
    table_names
        .into_iter()
        .map(|table_name| {
            let quoted_name = format!("\"{}\"", table_name.replace('"', "\"\""));
            let mut statement = connection
                .prepare(&format!("SELECT * FROM {quoted_name}"))
                .expect("durable table contents");
            let column_count = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    (0..column_count)
                        .map(|index| row.get(index))
                        .collect::<rusqlite::Result<Vec<SqlValue>>>()
                })
                .expect("durable row query")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("durable rows");
            (table_name, rows)
        })
        .collect()
}

fn assert_operational_fences(
    dispatch: &G1Dispatch,
    operational: &dolly_extension_host::OperationalPremise,
) {
    let invocation = operational.invocation();
    let fence = dispatch.premise.fence();
    let digests = dispatch.premise.digests();
    let expected_token_digest = Sha256Digest::compute(dispatch.lease_token.expose_bytes());

    // Activation, Extension, and Module identity.
    assert_eq!(
        invocation.activation_id(),
        dispatch.premise.identity().activation_id()
    );
    assert_eq!(invocation.extension_id(), Some("org.example.extension"));
    assert_eq!(
        invocation.module_id(),
        dispatch.premise.identity().module_id()
    );

    // Connection, Host incarnation, and WorkerEpoch fences.
    assert_eq!(
        invocation.extension_connection_id(),
        fence.extension_connection_id()
    );
    assert_eq!(
        invocation.incarnation_revision(),
        fence.incarnation_revision()
    );
    assert_eq!(invocation.worker_epoch(), fence.worker_epoch());
    assert_eq!(invocation.worker_epoch_fence(), fence.worker_epoch_fence());

    // Request, lease, and token-hash fences.
    assert_eq!(invocation.request_id(), fence.request_id());
    assert_eq!(invocation.reservation_id(), fence.reservation_id());
    assert_eq!(invocation.lease_id(), fence.lease_id());
    assert_eq!(
        invocation.lease_token_digest().to_string(),
        expected_token_digest.to_string()
    );

    // Generation and attempt fences.
    assert_eq!(
        invocation.extension_generation(),
        fence.extension_generation()
    );
    assert_eq!(invocation.lease_generation(), fence.lease_generation());
    assert_eq!(invocation.attempt(), fence.attempt());

    // Configuration, Descriptor, Manifest, and Graph revisions and digests.
    assert_eq!(
        invocation.manifest().config_revision.value(),
        dispatch.manifest["config_revision"]
            .as_u64()
            .expect("config revision")
    );
    assert_eq!(
        invocation.effective_config_digest().to_string(),
        dispatch.manifest["effective_config_digest"]
            .as_str()
            .expect("config digest")
    );
    assert_eq!(
        invocation.effective_config_schema_digest().to_string(),
        dispatch.manifest["effective_config_schema_digest"]
            .as_str()
            .expect("config schema digest")
    );
    assert_eq!(
        invocation.manifest().descriptor_revision.value(),
        dispatch.manifest["descriptor_revision"]
            .as_u64()
            .expect("descriptor revision")
    );
    assert_eq!(
        invocation.descriptor_digest().to_string(),
        digests.descriptor_digest()
    );
    assert_eq!(
        invocation.manifest_digest().to_string(),
        dispatch.manifest["manifest_digest"]
            .as_str()
            .expect("manifest digest")
    );
    assert_eq!(
        invocation.manifest().graph_revision.value(),
        dispatch.manifest["graph_revision"]
            .as_u64()
            .expect("graph revision")
    );
    assert_eq!(
        invocation.graph_digest().to_string(),
        digests.graph_digest()
    );
    assert_eq!(
        serde_json::to_value(invocation.manifest()).expect("admitted manifest"),
        dispatch.manifest
    );

    // Frame digest, order, replay scope, and the Host capability grant.
    assert_eq!(
        invocation.frame_digest().to_string(),
        dispatch.result.frame_digest()
    );
    assert_eq!(invocation.order(), dispatch.premise.order());
    assert_eq!(invocation.replay_scope(), dispatch.premise.replay_scope());
    assert_eq!(invocation.extension_id(), Some("org.example.extension"));
}

const G1_MATRIX: &str = include_str!("fixtures/g1_runtime_conformance.json");
const G2_MATRIX: &str = include_str!("fixtures/g2_extension_host_sdk_conformance.json");
const G3_MATRIX: &str = include_str!("fixtures/g3_operable_local_conformance.json");

fn document(source: &str, label: &str) -> Value {
    serde_json::from_str(source)
        .unwrap_or_else(|error| panic!("{label} fixture must be valid JSON: {error}"))
}

fn case<'a>(document: &'a Value, id: &str, label: &str) -> &'a Value {
    document["cases"]
        .as_array()
        .unwrap_or_else(|| panic!("{label} matrix cases must be an array"))
        .iter()
        .find(|candidate| candidate["id"] == id)
        .unwrap_or_else(|| panic!("{label} matrix case {id} is missing"))
}

#[test]
fn g3_operable_local_001_valid_committed_g2_invocation_reaches_supervised_local_premise_before_io()
{
    let g1 = document(G1_MATRIX, "accepted G1");
    let g2 = document(G2_MATRIX, "accepted G2");
    let g3 = document(G3_MATRIX, "G3");
    let source_boundary = &g3["source_boundary"];
    let g1_case = case(&g1, "G1-EXEC-001", "accepted G1");
    let g2_case = case(&g2, "G2-ADMISSION-001", "accepted G2");
    let g3_case = case(&g3, "G3-OPERABLE-LOCAL-001", "G3");

    assert_eq!(
        source_boundary["g1_fixture"],
        "crates/dolly-runtime/tests/fixtures/g1_runtime_conformance.json"
    );
    assert_eq!(
        source_boundary["g2_fixture"],
        "crates/dolly-runtime/tests/fixtures/g2_extension_host_sdk_conformance.json"
    );
    assert_eq!(source_boundary["g1_case"], g1_case["id"]);
    assert_eq!(source_boundary["g2_case"], g2_case["id"]);
    assert_eq!(g1_case["expected"], "product_red");
    assert_eq!(g2_case["expected"], "product_red");
    assert_eq!(g2_case["source_case"], g1_case["id"]);

    assert_eq!(g3_case["expected"], "pass");
    assert_eq!(g3_case["source_case"], g2_case["id"]);
    assert_eq!(g3_case["fences"], g2_case["fences"]);
    assert_eq!(
        g3_case["required_boundary"],
        "one explicit supervised-local operational premise"
    );
    assert_eq!(g3_case["effect_boundary"], "before external I/O");
    assert_eq!(
        source_boundary["effect_boundary"],
        g3_case["effect_boundary"]
    );
    assert_eq!(
        g3_case["stop_conditions"],
        json!([
            "no credential resolution",
            "no external transport invocation",
            "no new authority or storage scope"
        ])
    );
    assert_eq!(
        g3_case["fences"].as_array().expect("G3 fence groups").len(),
        11
    );
    let mut dispatch = dispatch_g1_case(g1_case);
    let observed_frame =
        serde_json::from_slice(dispatch.result.frame_bytes()).expect("canonical G1 frame JSON");
    let mut expected_frame = g1_case["expected_request"].clone();
    expected_frame["id"] = json!(dispatch.premise.fence().request_id());
    expected_frame["params"]["manifest"] = dispatch.manifest.clone();
    assert_eq!(observed_frame, expected_frame);
    assert_eq!(
        canonical_digest(&observed_frame),
        dispatch.result.frame_digest()
    );
    let before_core = {
        let store = SqliteCoreStore::new(&mut dispatch.connection)
            .expect("core schema before operational admission");
        store
            .snapshot()
            .expect("core state before operational admission")
    };
    let before_durable = durable_snapshot(&dispatch.connection);
    let operational = {
        let store = SqliteCoreStore::new(&mut dispatch.connection)
            .expect("core schema for operational admission");
        dolly_extension_host::admit_operational_activation(
            &dispatch.premise,
            &dispatch.result,
            &store,
            FrameLimits::defaults(),
        )
        .expect("accepted G2 invocation must reach operational premise")
    };
    let after_core = {
        let store = SqliteCoreStore::new(&mut dispatch.connection)
            .expect("core schema after operational admission");
        store
            .snapshot()
            .expect("core state after operational admission")
    };
    let after_durable = durable_snapshot(&dispatch.connection);

    assert_eq!(before_core, after_core);
    assert_eq!(before_core.journal, after_core.journal);
    assert_eq!(before_durable, after_durable);
    assert_eq!(before_core.outputs, after_core.outputs);
    assert_eq!(before_core.deliveries, after_core.deliveries);
    assert_eq!(before_core.pages, after_core.pages);
    assert_eq!(before_core.blocks, after_core.blocks);
    assert_operational_fences(&dispatch, &operational);
}

#[test]
fn g3_matrix_has_seven_passing_cases_and_only_pass_fail_closed_controls() {
    let g3 = document(G3_MATRIX, "G3");
    let cases = g3["cases"]
        .as_array()
        .expect("G3 matrix cases must be an array");

    let passing_cases: Vec<&Value> = cases
        .iter()
        .filter(|candidate| candidate["expected"] == "pass")
        .collect();
    let product_red_cases: Vec<&Value> = cases
        .iter()
        .filter(|candidate| candidate["expected"] == "product_red")
        .collect();
    let skipped_cases: Vec<&Value> = cases
        .iter()
        .filter(|candidate| candidate["expected"] == "skip")
        .collect();
    assert_eq!(cases.len(), 7);
    assert_eq!(passing_cases.len(), 7, "G3 must have seven passing cases");
    assert_eq!(
        product_red_cases.len(),
        0,
        "G3 must have no product-red cases"
    );
    assert_eq!(skipped_cases.len(), 0, "G3 must have no skipped cases");

    let controls: Vec<&Value> = cases
        .iter()
        .filter(|candidate| candidate["kind"] == "fail_closed_control")
        .collect();
    assert_eq!(
        controls.len(),
        6,
        "G3 must keep the external invalid-control matrix minimal"
    );
    assert!(
        cases
            .iter()
            .all(|candidate| candidate["expected"] != "skip"),
        "G3 must not encode skipped cases"
    );

    for control in controls {
        assert_eq!(control["expected"], "pass");
        let references = control["references"]
            .as_array()
            .unwrap_or_else(|| panic!("{} must reference an accepted control", control["id"]));
        assert!(!references.is_empty());
        assert!(references.iter().all(|reference| {
            reference
                .as_str()
                .is_some_and(|value| !value.trim().is_empty())
        }));
    }
}
