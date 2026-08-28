use super::*;
use dolly_canonical_json::{Sha256Digest, canonicalize};
use dolly_core_reducer::{
    BuildManifestCommand, CoreCommand, EnvironmentInput, FrozenDescriptor, InstallConfigCommand,
    InstallGraphCommand, NeighborGraph, TransitionOutcome, build_neighbor_descriptors,
};
use dolly_core_domain::LeaseToken;
use dolly_storage::SqliteCoreStore;
use rusqlite::Connection;
use serde_json::{Value, json};

const SHA_ZERO: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const ACTIVATION_ID: &str = "0198ab31-6c44-7e8a-b2bb-000000000004";

fn digest(value: &Value) -> String {
    canonicalize(value).unwrap().1.to_canonical_string()
}

fn descriptor(module_id: &str, revision: i64) -> Value {
    json!({
        "schema": "dolly.module-descriptor/v1",
        "module_id": module_id,
        "descriptor_revision": revision,
        "display_name": module_id,
        "accepts": {"summary":"input","part_kinds":["text"],"action_names":[]},
        "emits": {"summary":"output","part_kinds":["text"],"action_names":[]},
        "actions": [],
        "activation_replay_contract": {"mode":"fenced_replay","evidence":"pure_compute","ledger":null},
        "trust": "trusted",
        "metadata": {}
    })
}

fn graph() -> Value {
    let receiver = descriptor("receiver", 9);
    let producer = descriptor("producer", 3);
    let consumer = descriptor("consumer", 4);
    json!({
        "receiving_module": "receiver",
        "input_pages": {"receiver":["in"]},
        "output_pages": {"producer":["in"],"receiver":["out"]},
        "subscriptions": {"out":["consumer"]},
        "descriptors": {
            "receiver": {"module_id":"receiver","descriptor_revision":9,"source_descriptor_digest":digest(&receiver),"value":receiver},
            "producer": {"module_id":"producer","descriptor_revision":3,"source_descriptor_digest":digest(&producer),"value":producer},
            "consumer": {"module_id":"consumer","descriptor_revision":4,"source_descriptor_digest":digest(&consumer),"value":consumer}
        },
        "authorized_metadata_namespaces": [],
        "authorized_action_names": []
    })
}

fn manifest(module_id: &str, config: &Value, activation_id: &str) -> Value {
    let receiver = descriptor("receiver", 9);
    let producer = descriptor("producer", 3);
    let consumer = descriptor("consumer", 4);
    let neighbor_graph = NeighborGraph {
        receiving_module: module_id.into(),
        input_pages: [(module_id.into(), vec!["in".into()])]
            .into_iter()
            .collect(),
        output_pages: [
            ("producer".into(), vec!["in".into()]),
            (module_id.into(), vec!["out".into()]),
        ]
        .into_iter()
        .collect(),
        subscriptions: [("out".into(), vec!["consumer".into()])]
            .into_iter()
            .collect(),
        descriptors: [
            (
                "receiver".into(),
                FrozenDescriptor {
                    module_id: "receiver".into(),
                    descriptor_revision: 9,
                    source_descriptor_digest: digest(&receiver),
                    value: receiver,
                },
            ),
            (
                "producer".into(),
                FrozenDescriptor {
                    module_id: "producer".into(),
                    descriptor_revision: 3,
                    source_descriptor_digest: digest(&producer),
                    value: producer,
                },
            ),
            (
                "consumer".into(),
                FrozenDescriptor {
                    module_id: "consumer".into(),
                    descriptor_revision: 4,
                    source_descriptor_digest: digest(&consumer),
                    value: consumer,
                },
            ),
        ]
        .into_iter()
        .collect(),
        authorized_metadata_namespaces: vec![],
        authorized_action_names: vec![],
    };
    let neighbors = build_neighbor_descriptors(&neighbor_graph).unwrap();
    let effective_config_digest = digest(config);
    let mut value = json!({
        "schema":"dolly.activation-manifest/v1",
        "activation_id":activation_id,
        "module_id":module_id,
        "reason":"input",
        "created_at":"2026-08-27T00:00:00.000000Z",
        "graph_revision":1,
        "config_revision":1,
        "descriptor_revision":9,
        "effective_config":config,
        "effective_config_digest":effective_config_digest,
        "effective_config_schema_digest":SHA_ZERO,
        "input_items":[],
        "cursor_spans":[],
        "lossy_gaps":[],
        "output_page_ids":["out"],
        "neighbor_descriptors":neighbors,
        "required_frame_bytes":1,
        "required_frame_nesting_depth":1,
        "deadline":"2026-08-27T00:02:00.000000Z",
        "manifest_digest":SHA_ZERO
    });
    value.as_object_mut().unwrap().remove("manifest_digest");
    let manifest_digest = digest(&value);
    value["manifest_digest"] = Value::String(manifest_digest);
    value
}

fn environment() -> EnvironmentInput {
    EnvironmentInput {
        now: "2026-08-27T00:00:00.000000Z".into(),
        graph_revision: Some(1),
        descriptor_revision: Some(9),
        ..Default::default()
    }
}

fn setup() -> (Connection, Value) {
    let mut connection = Connection::open_in_memory().unwrap();
    let graph_value = graph();
    let config = json!({
        "model":"test",
        "extension_connection_id":"connection-1",
        "worker_epoch":"0198ab31-6c44-7e8a-b2bb-000000000010",
        "worker_epoch_fence":1
    });
    let input = environment();
    {
        let mut store = SqliteCoreStore::new(&mut connection).unwrap();
        let config_command = CoreCommand::InstallConfig(InstallConfigCommand {
            command_id: "install-config".into(),
            revision: 1,
            digest: digest(&config),
            effective_config: config.clone(),
        });
        let graph_command = CoreCommand::InstallGraph(InstallGraphCommand {
            command_id: "install-graph".into(),
            revision: 1,
            digest: digest(&graph_value),
            graph: graph_value.clone(),
        });
        assert_eq!(
            store.transact(&config_command, &input).unwrap().outcome,
            TransitionOutcome::Committed
        );
        assert_eq!(
            store.transact(&graph_command, &input).unwrap().outcome,
            TransitionOutcome::Committed
        );
    }
    (
        connection,
        manifest("receiver", &config, ACTIVATION_ID),
    )
}

fn build_command(manifest: Value, activation_id: &str, command_id: &str) -> BuildManifestCommand {
    BuildManifestCommand {
        command_id: command_id.into(),
        activation_id: activation_id.into(),
        manifest,
        expected_graph_revision: Some(1),
        expected_descriptor_revision: Some(9),
    }
}

fn lease_command(command_id: &str, lease_id: &str, token_digest: &str) -> LeaseRequest {
    LeaseRequest::new(
        command_id,
        ACTIVATION_ID,
        lease_id,
        token_digest,
        Some(7),
    )
}

#[test]
fn accepted_transaction_mints_one_premise_and_stops_before_effects() {
    let (mut connection, manifest) = setup();
    let input = environment();
    let mut engine = RuntimeTransactionEngine::new(&mut connection).unwrap();
    let build = build_command(manifest, ACTIVATION_ID, "build-1");
    let built = engine.accept_manifest(&build, &input).unwrap();
    assert_eq!(
        built.state.activations[ACTIVATION_ID].state,
        ActivationState::Ready
    );

    let lease = lease_command("lease-1", "lease-1", SHA_ZERO);
    let premise = engine.prepare_execution(&lease, &input).unwrap();
    assert_eq!(premise.identity().activation_id(), ACTIVATION_ID);
    assert_eq!(premise.identity().module_id(), "receiver");
    assert_eq!(premise.fence().extension_generation(), 7);
    assert_eq!(premise.fence().lease_generation(), 1);
    assert_eq!(premise.order().output_page_ids(), &["out".to_string()]);
    assert_eq!(
        premise.replay_scope().evidence(),
        ReplayEvidence::PureCompute
    );

    let state = engine.snapshot().unwrap();
    assert_eq!(
        state.activations[ACTIVATION_ID].state,
        ActivationState::Leased
    );
    assert!(state.outputs.is_empty());
}

#[test]
fn forged_direction_cannot_mint_a_premise_or_manifest() {
    let (mut connection, mut manifest) = setup();
    let input = environment();
    let mut engine = RuntimeTransactionEngine::new(&mut connection).unwrap();
    manifest["activation_id"] = json!("0198ab31-6c44-7e8a-b2bb-000000000005");
    manifest["neighbor_descriptors"][1]["relationships"] = json!(["output_consumer"]);
    manifest.as_object_mut().unwrap().remove("manifest_digest");
    manifest["manifest_digest"] = json!(digest(&manifest));
    let result = engine.accept_manifest(
        &build_command(manifest, "0198ab31-6c44-7e8a-b2bb-000000000005", "forged-1"),
        &input,
    );
    assert!(result.is_err(), "forged cross-premise input was accepted");
    assert!(engine.snapshot().unwrap().manifests.is_empty());
}

#[test]
fn exact_lease_replay_returns_same_premise_and_changed_fence_is_rejected() {
    let (mut connection, manifest) = setup();
    let input = environment();
    let mut engine = RuntimeTransactionEngine::new(&mut connection).unwrap();
    engine
        .accept_manifest(
            &build_command(manifest, ACTIVATION_ID, "build-replay"),
            &input,
        )
        .unwrap();
    let lease = lease_command("lease-replay", "lease-replay", SHA_ZERO);
    let first = engine.prepare_execution(&lease, &input).unwrap();
    let before = engine.snapshot().unwrap();
    let replay = engine.prepare_execution(&lease, &input).unwrap();
    assert_eq!(first, replay);
    assert_eq!(before, engine.snapshot().unwrap());

    let changed = lease_command(
        "lease-conflict",
        "lease-replay",
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    );
    let result = engine.prepare_execution(&changed, &input);
    assert!(matches!(result, Err(RuntimeError::ReplayConflict { .. })));
    assert_eq!(before, engine.snapshot().unwrap());
}

#[test]
fn mismatched_worker_epoch_cannot_authorize_frame() {
    let (mut connection, mut manifest) = setup();
    manifest["required_frame_bytes"] = json!(2048);
    manifest["required_frame_nesting_depth"] = json!(10);
    manifest.as_object_mut().unwrap().remove("manifest_digest");
    manifest["manifest_digest"] = Value::String(digest(&manifest));
    let input = environment();
    let mut engine = RuntimeTransactionEngine::new(&mut connection).unwrap();
    engine
        .accept_manifest(
            &build_command(manifest, ACTIVATION_ID, "build-mismatch"),
            &input,
        )
        .unwrap();

    let lease_token: LeaseToken =
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".parse().unwrap();
    let token_digest =
        Sha256Digest::compute(lease_token.expose_bytes()).to_canonical_string();
    let lease = lease_command("lease-mismatch", "lease-mismatch", &token_digest);
    let premise = engine.prepare_execution(&lease, &input).unwrap();
    drop(engine);
    let mismatched_config = json!({
        "model":"test",
        "extension_connection_id":"connection-1",
        "worker_epoch":"0198ab31-6c44-7e8a-b2bb-000000000099",
        "worker_epoch_fence":1
    });
    {
        let mut store = SqliteCoreStore::new(&mut connection).unwrap();
        let changed = CoreCommand::InstallConfig(InstallConfigCommand {
            command_id: "install-config-mismatch".into(),
            revision: 2,
            digest: digest(&mismatched_config),
            effective_config: mismatched_config,
        });
        assert_eq!(
            store.transact(&changed, &input).unwrap().outcome,
            TransitionOutcome::Committed
        );
    }
    let mut engine = RuntimeTransactionEngine::new(&mut connection).unwrap();
    let result = engine.dispatch_execution(
        &premise,
        "dispatch-mismatch",
        &lease_token,
        "rpc-mismatch",
        &input,
    );

    assert!(
        result.is_err(),
        "a mismatched caller epoch authorized a frame"
    );
    assert_eq!(
        engine.snapshot().unwrap().activations[ACTIVATION_ID].state,
        ActivationState::Leased
    );
}
