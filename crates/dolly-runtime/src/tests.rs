use super::*;
use dolly_canonical_json::{Sha256Digest, canonicalize};
use dolly_core_reducer::{
    BeginFenceCommand, BuildManifestCommand, CoreCommand, EnvironmentInput, FenceCompleteCommand,
    FrozenDescriptor, HostFenceVerification, InstallConfigCommand, InstallGraphCommand,
    NeighborGraph, TransitionOutcome, build_neighbor_descriptors,
};
use dolly_core_domain::LeaseToken;
use dolly_storage::SqliteCoreStore;
use rusqlite::Connection;
use serde_json::{Value, json};

const SHA_ZERO: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const ACTIVATION_ID: &str = "0198ab31-6c44-7e8a-b2bb-000000000004";
const SECOND_ACTIVATION_ID: &str = "0198ab31-6c44-7e8a-b2bb-000000000005";

fn digest(value: &Value) -> String {
    canonicalize(value).unwrap().1.to_canonical_string()
}
fn runtime_config() -> Value {
    json!({
        "model":"test",
        "extension_connection_id":"connection-1",
        "worker_epoch":"0198ab31-6c44-7e8a-b2bb-000000000010",
        "worker_epoch_fence":1
    })
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
            "receiver": {"module_id":"receiver","descriptor_revision":9,"source_descriptor_digest":digest(&receiver),"owner_extension_id":"org.dolly.test","value":receiver},
            "producer": {"module_id":"producer","descriptor_revision":3,"source_descriptor_digest":digest(&producer),"owner_extension_id":"org.dolly.test","value":producer},
            "consumer": {"module_id":"consumer","descriptor_revision":4,"source_descriptor_digest":digest(&consumer),"owner_extension_id":"org.dolly.test","value":consumer}
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
                    owner_extension_id: "org.dolly.test".into(),
                    value: receiver,
                },
            ),
            (
                "producer".into(),
                FrozenDescriptor {
                    module_id: "producer".into(),
                    descriptor_revision: 3,
                    source_descriptor_digest: digest(&producer),
                    owner_extension_id: "org.dolly.test".into(),
                    value: producer,
                },
            ),
            (
                "consumer".into(),
                FrozenDescriptor {
                    module_id: "consumer".into(),
                    descriptor_revision: 4,
                    source_descriptor_digest: digest(&consumer),
                    owner_extension_id: "org.dolly.test".into(),
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
    let config = runtime_config();
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
        store
            .bootstrap_host_connection()
            .expect("Host connection bootstrap");
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

fn lease_command_for(
    activation_id: &str,
    command_id: &str,
    lease_id: &str,
    token_digest: &str,
) -> LeaseRequest {
    LeaseRequest::new(command_id, activation_id, lease_id, token_digest, Some(7))
}

fn lease_command(command_id: &str, lease_id: &str, token_digest: &str) -> LeaseRequest {
    lease_command_for(ACTIVATION_ID, command_id, lease_id, token_digest)
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
    let reservation = engine.allocate_request(&lease, &input).unwrap();
    let premise = engine.prepare_execution(&lease, &reservation, &input).unwrap();
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
    let reservation = engine.allocate_request(&lease, &input).unwrap();
    let first = engine.prepare_execution(&lease, &reservation, &input).unwrap();
    let before = engine.snapshot().unwrap();
    let replay = engine.prepare_execution(&lease, &reservation, &input).unwrap();
    assert_eq!(first, replay);
    assert_eq!(before, engine.snapshot().unwrap());

    let changed = lease_command(
        "lease-conflict",
        "lease-replay",
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    );
    let result = engine.prepare_execution(&changed, &reservation, &input);
    assert!(matches!(result, Err(RuntimeError::ReplayConflict { .. })));
    assert_eq!(before, engine.snapshot().unwrap());
}

#[test]
fn duplicate_request_identity_is_rejected_before_dispatch() {
    let (mut connection, first_manifest) = setup();
    let second_manifest = manifest("receiver", &runtime_config(), SECOND_ACTIVATION_ID);
    let input = environment();
    let mut engine = RuntimeTransactionEngine::new(&mut connection).unwrap();
    engine
        .accept_manifest(
            &build_command(first_manifest, ACTIVATION_ID, "build-duplicate-first"),
            &input,
        )
        .unwrap();
    engine
        .accept_manifest(
            &build_command(second_manifest, SECOND_ACTIVATION_ID, "build-duplicate-second"),
            &input,
        )
        .unwrap();

    let first_lease = lease_command("lease-duplicate-first", "lease-duplicate-first", SHA_ZERO);
    let reservation = engine.allocate_request(&first_lease, &input).unwrap();
    let premise = engine
        .prepare_execution(&first_lease, &reservation, &input)
        .unwrap();
    let second_lease = lease_command_for(
        SECOND_ACTIVATION_ID,
        "lease-duplicate-second",
        "lease-duplicate-second",
        SHA_ZERO,
    );
    let result = engine.prepare_execution(&second_lease, &reservation, &input);

    assert!(matches!(result, Err(RuntimeError::ReplayConflict { .. })));
    let state = engine.snapshot().unwrap();
    assert_eq!(state.activations[ACTIVATION_ID].state, ActivationState::Leased);
    assert_eq!(
        state.activations[SECOND_ACTIVATION_ID].state,
        ActivationState::Ready
    );
    assert_eq!(state.leases.len(), 1);
    assert_eq!(
        state.leases["lease-duplicate-first"]["request_id"],
        premise.fence().request_id()
    );
    assert_eq!(
        state.leases["lease-duplicate-first"]["dispatch_state"],
        "prepared"
    );
    assert!(state.outputs.is_empty());
}

#[test]
fn config_request_id_cannot_override_host_allocator() {
    let (mut connection, mut manifest) = setup();
    manifest["required_frame_bytes"] = json!(2048);
    manifest["required_frame_nesting_depth"] = json!(10);
    manifest.as_object_mut().unwrap().remove("manifest_digest");
    manifest["manifest_digest"] = Value::String(digest(&manifest));
    let input = environment();
    {
        let mut engine = RuntimeTransactionEngine::new(&mut connection).unwrap();
        engine
            .accept_manifest(
                &build_command(manifest, ACTIVATION_ID, "build-config-injection"),
                &input,
            )
            .unwrap();
    }

    let injected_request_id = "x".repeat(129);
    let mut injected_config = runtime_config();
    injected_config["request_id"] = json!(injected_request_id);
    {
        let mut store = SqliteCoreStore::new(&mut connection).unwrap();
        let command = CoreCommand::InstallConfig(InstallConfigCommand {
            command_id: "install-config-injection".into(),
            revision: 2,
            digest: digest(&injected_config),
            effective_config: injected_config,
        });
        let transition = store.transact(&command, &input).unwrap();
        assert_eq!(transition.outcome, TransitionOutcome::RolledBack);
        assert_eq!(
            transition.error.as_ref().unwrap().code,
            "CONFIG_REQUEST_ID_FORBIDDEN"
        );
    }

    let lease_token: LeaseToken =
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".parse().unwrap();
    let token_digest =
        Sha256Digest::compute(lease_token.expose_bytes()).to_canonical_string();
    let lease = lease_command("lease-config-injection", "lease-config-injection", &token_digest);
    let mut engine = RuntimeTransactionEngine::new(&mut connection).unwrap();
    assert!(engine.snapshot().unwrap().config["effective_config"]
        .get("request_id")
        .is_none());
    let reservation = engine.allocate_request(&lease, &input).unwrap();
    let premise = engine
        .prepare_execution(&lease, &reservation, &input)
        .unwrap();
    assert_ne!(premise.fence().request_id(), injected_request_id);
    assert!(premise.fence().request_id().len() <= 128);
    let dispatched = engine
        .dispatch_execution(
            &premise,
            "dispatch-config-injection",
            &lease_token,
            &input,
        )
        .unwrap();
    let frame: Value = serde_json::from_slice(dispatched.frame_bytes()).unwrap();
    assert_ne!(frame["id"], injected_request_id);
    assert_eq!(
        engine.snapshot().unwrap().activations[ACTIVATION_ID].state,
        ActivationState::Dispatched
    );
    assert!(engine.snapshot().unwrap().outputs.is_empty());
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
    let reservation = engine.allocate_request(&lease, &input).unwrap();
    let premise = engine.prepare_execution(&lease, &reservation, &input).unwrap();
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
        let current = store
            .authenticated_host_connection()
            .expect("current Host authority");
        store
            .rotate_host_connection(&current)
            .expect("Host rotation");
    }
    let mut engine = RuntimeTransactionEngine::new(&mut connection).unwrap();
    let result = engine.dispatch_execution(
        &premise,
        "dispatch-mismatch",
        &lease_token,
        &input,
    );

    assert!(
        result.is_err(),
        "a mismatched current Host WorkerEpoch authorized a frame"
    );
    assert_eq!(
        engine.snapshot().unwrap().activations[ACTIVATION_ID].state,
        ActivationState::Leased
    );
}

#[test]
fn rotated_host_authority_dispatches_with_new_revision() {
    let (mut connection, _) = setup();
    let input = environment();
    let mut rotated_config = runtime_config();
    rotated_config["extension_connection_id"] = json!("connection-2");
    rotated_config["worker_epoch"] =
        json!("0198ab31-6c44-7e8a-b2bb-000000000011");
    rotated_config["worker_epoch_fence"] = json!(2);
    {
        let mut store = SqliteCoreStore::new(&mut connection).unwrap();
        let changed = CoreCommand::InstallConfig(InstallConfigCommand {
            command_id: "install-config-rotation".into(),
            revision: 2,
            digest: digest(&rotated_config),
            effective_config: rotated_config.clone(),
        });
        assert_eq!(
            store.transact(&changed, &input).unwrap().outcome,
            TransitionOutcome::Committed
        );
        let current = store
            .authenticated_host_connection()
            .expect("current Host authority");
        let rotated = store
            .rotate_host_connection(&current)
            .expect("Host rotation");
        assert_eq!(rotated.incarnation_revision(), 2);
    }
    let mut manifest = manifest("receiver", &rotated_config, SECOND_ACTIVATION_ID);
    manifest["config_revision"] = json!(2);
    manifest["required_frame_bytes"] = json!(2048);
    manifest["required_frame_nesting_depth"] = json!(10);
    manifest.as_object_mut().unwrap().remove("manifest_digest");
    manifest["manifest_digest"] = Value::String(digest(&manifest));
    let mut engine = RuntimeTransactionEngine::new(&mut connection).unwrap();
    engine
        .accept_manifest(
            &build_command(manifest, SECOND_ACTIVATION_ID, "build-rotation"),
            &input,
        )
        .unwrap();
    let lease_token: LeaseToken =
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".parse().unwrap();
    let token_digest =
        Sha256Digest::compute(lease_token.expose_bytes()).to_canonical_string();
    let lease = lease_command_for(
        SECOND_ACTIVATION_ID,
        "lease-rotation",
        "lease-rotation",
        &token_digest,
    );
    let reservation = engine.allocate_request(&lease, &input).unwrap();
    assert_eq!(reservation.incarnation_revision, 2);
    let premise = engine.prepare_execution(&lease, &reservation, &input).unwrap();
    assert_eq!(premise.fence().incarnation_revision(), 2);
    engine
        .dispatch_execution(&premise, "dispatch-rotation", &lease_token, &input)
        .unwrap();
    assert_eq!(
        engine.snapshot().unwrap().activations[SECOND_ACTIVATION_ID].state,
        ActivationState::Dispatched
    );
}

#[test]
fn fence_complete_releases_bound_request_reservation() {
    let (mut connection, mut manifest) = setup();
    manifest["required_frame_bytes"] = json!(2048);
    manifest["required_frame_nesting_depth"] = json!(10);
    manifest.as_object_mut().unwrap().remove("manifest_digest");
    manifest["manifest_digest"] = Value::String(digest(&manifest));
    let input = environment();
    let mut engine = RuntimeTransactionEngine::new(&mut connection).unwrap();
    engine
        .accept_manifest(
            &build_command(manifest, ACTIVATION_ID, "build-release"),
            &input,
        )
        .unwrap();
    let lease_token: LeaseToken =
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".parse().unwrap();
    let token_digest =
        Sha256Digest::compute(lease_token.expose_bytes()).to_canonical_string();
    let lease = lease_command("lease-release", "lease-release", &token_digest);
    let reservation = engine.allocate_request(&lease, &input).unwrap();
    let premise = engine
        .prepare_execution(&lease, &reservation, &input)
        .unwrap();
    engine
        .dispatch_execution(&premise, "dispatch-release", &lease_token, &input)
        .unwrap();
    let reservation_id = premise.fence().reservation_id().to_owned();
    let begin = CoreCommand::BeginFence(BeginFenceCommand {
        command_id: "begin-release".into(),
        activation_id: ACTIVATION_ID.into(),
    });
    assert_eq!(
        engine.store.transact(&begin, &input).unwrap().outcome,
        TransitionOutcome::Committed
    );
    let mut fence_input = input.clone();
    fence_input.host_fence_verification = Some(HostFenceVerification {
        verified: true,
        activation_id: ACTIVATION_ID.into(),
        source_attempt: premise.fence().attempt(),
        execution_slot_empty: true,
        proof_digest: SHA_ZERO.into(),
    });
    let complete = CoreCommand::FenceComplete(FenceCompleteCommand {
        command_id: "complete-release".into(),
        activation_id: ACTIVATION_ID.into(),
        retry_delay: 1,
    });
    let completed = engine.store.transact(&complete, &fence_input).unwrap();
    assert_eq!(completed.outcome, TransitionOutcome::Committed);
    let state = engine.snapshot().unwrap();
    assert_eq!(
        state.host_request_reservations[&reservation_id]["state"],
        "released"
    );
    assert_eq!(
        state.journal.last().unwrap().details.as_ref().unwrap()
            ["request_reservation_released"]["request_id"],
        premise.fence().request_id()
    );
}
