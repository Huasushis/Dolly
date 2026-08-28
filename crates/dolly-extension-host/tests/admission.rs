use dolly_canonical_json::{CanonicalJsonObject, CanonicalJsonValue, Sha256Digest, canonicalize};
use dolly_core_domain::LeaseToken;
use dolly_core_reducer::{
    BuildManifestCommand, CoreCommand, EnvironmentInput, InstallConfigCommand, InstallGraphCommand,
    TransitionOutcome,
};
use dolly_extension_host::{admit_activation, admit_sdk_capability, AdmissionError};
use dolly_extension_sdk::{CapabilityRequest, ResultData};
use dolly_protocol::FrameLimits;
use dolly_runtime::{DispatchResult, LeaseRequest, RuntimeTransactionEngine};
use dolly_storage::SqliteCoreStore;
use rusqlite::Connection;
use serde_json::{Value, json};

const ACTIVATION_ID: &str = "0198ab31-6c44-7e8a-b2bb-000000000111";
const WORKER_EPOCH: &str = "0198ab31-6c44-7e8a-b2bb-000000000110";
const LEASE_TOKEN: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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
fn digest(value: &Value) -> String {
    canonicalize(value).unwrap().1.to_canonical_string()
}

fn descriptor() -> Value {
    json!({
        "schema": "dolly.module-descriptor/v1",
        "module_id": "timer",
        "descriptor_revision": 1,
        "display_name": "timer",
        "accepts": {"summary":"input", "part_kinds":["text"], "action_names":[]},
        "emits": {"summary":"output", "part_kinds":["text"], "action_names":[]},
        "actions": [],
        "activation_replay_contract": {"mode":"fenced_replay", "evidence":"pure_compute", "ledger":null},
        "trust": "trusted",
        "metadata": {"org.example.extension":{"capabilities":["host.block.get"]}}
    })
}

fn graph() -> Value {
    let source = descriptor();
    json!({
        "receiving_module": "timer",
        "input_pages": {},
        "output_pages": {},
        "subscriptions": {},
        "descriptors": {
            "timer": {
                "module_id": "timer",
                "descriptor_revision": 1,
                "source_descriptor_digest": digest(&source),
                "value": source
            }
        },
        "authorized_metadata_namespaces": ["org.example.extension"],
        "authorized_action_names": []
    })
}

fn install(store: &mut SqliteCoreStore<'_>) {
    let config = json!({
        "execution_timeout_ms": 120000,
        "lease_grace_ms": 30000,
        "fencing_grace_ms": 5000,
        "extension_connection_id": "g2-extension-connection",
        "worker_epoch": WORKER_EPOCH,
        "worker_epoch_fence": 17
    });
    let config_transition = store
        .transact(
            &CoreCommand::InstallConfig(InstallConfigCommand {
                command_id: "g2-config".into(),
                revision: 1,
                digest: digest(&config),
                effective_config: config,
            }),
            &input(),
        )
        .unwrap();
    assert_eq!(config_transition.outcome, TransitionOutcome::Committed);
    let graph = graph();
    let graph_transition = store
        .transact(
            &CoreCommand::InstallGraph(InstallGraphCommand {
                command_id: "g2-graph".into(),
                revision: 1,
                digest: digest(&graph),
                graph,
            }),
            &input(),
        )
        .unwrap();
    assert_eq!(graph_transition.outcome, TransitionOutcome::Committed);
    store.bootstrap_host_connection().unwrap();
}

fn manifest() -> Value {
    let config = json!({
        "execution_timeout_ms": 120000,
        "lease_grace_ms": 30000,
        "fencing_grace_ms": 5000,
        "extension_connection_id": "g2-extension-connection",
        "worker_epoch": WORKER_EPOCH,
        "worker_epoch_fence": 17
    });
    let mut value = json!({
        "schema": "dolly.activation-manifest/v1",
        "activation_id": ACTIVATION_ID,
        "module_id": "timer",
        "reason": "timer",
        "created_at": "2026-08-27T00:00:00.000000Z",
        "graph_revision": 1,
        "config_revision": 1,
        "descriptor_revision": 1,
        "effective_config": config,
        "effective_config_digest": digest(&config),
        "effective_config_schema_digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "input_items": [],
        "cursor_spans": [],
        "lossy_gaps": [],
        "output_page_ids": [],
        "neighbor_descriptors": [],
        "required_frame_bytes": 2048,
        "required_frame_nesting_depth": 20,
        "deadline": "2026-08-27T00:02:00.000000Z",
        "manifest_digest": null
    });
    let mut digestable = value.clone();
    digestable
        .as_object_mut()
        .unwrap()
        .remove("manifest_digest");
    value["manifest_digest"] = json!(digest(&digestable));
    value
}
fn install_grant(
    store: &mut SqliteCoreStore<'_>,
    manifest: &Value,
    extension_id: &str,
    extension_generation: i64,
) {
    let authority = store.authenticated_host_connection().unwrap();
    store
        .install_host_capability_grant(
            &authority,
            extension_id,
            "timer",
            extension_generation,
            manifest["descriptor_revision"].as_i64().unwrap(),
            &digest(&descriptor()),
            manifest["config_revision"].as_i64().unwrap(),
            manifest["manifest_digest"].as_str().unwrap(),
            manifest["graph_revision"].as_i64().unwrap(),
            &digest(&graph()),
            &["host.block.get"],
        )
        .unwrap();
}

#[test]
fn accepted_g1_frame_becomes_fenced_premise_and_replay_is_same_key() {
    let mut connection = Connection::open_in_memory().unwrap();
    {
        let mut store = SqliteCoreStore::new(&mut connection).unwrap();
        install(&mut store);
    }
    let manifest = manifest();
    let (premise, dispatch, lease_token) = {
        let mut engine = RuntimeTransactionEngine::new(&mut connection).unwrap();
        let build = BuildManifestCommand {
            command_id: "g2-build".into(),
            activation_id: ACTIVATION_ID.into(),
            manifest: manifest.clone(),
            expected_graph_revision: Some(1),
            expected_descriptor_revision: Some(1),
        };
        engine.accept_manifest(&build, &graph_input()).unwrap();
        let lease_token: LeaseToken = LEASE_TOKEN.parse().unwrap();
        let token_digest = Sha256Digest::compute(lease_token.expose_bytes()).to_canonical_string();
        let request = LeaseRequest::new(
            "g2-lease",
            ACTIVATION_ID,
            "g2-lease-id",
            token_digest,
            Some(7),
        );
        let reservation = engine.allocate_request(&request, &graph_input()).unwrap();
        let premise = engine
            .prepare_execution(&request, &reservation, &graph_input())
            .unwrap();
        let dispatch: DispatchResult = engine
            .dispatch_execution(&premise, "g2-dispatch", &lease_token, &input())
            .unwrap();
        (premise, dispatch, lease_token)
    };
    let mut store = SqliteCoreStore::new(&mut connection).unwrap();
    assert_eq!(
        admit_activation(
            &premise,
            &dispatch,
            &store,
            FrameLimits::defaults()
        )
        .unwrap_err(),
        AdmissionError::CapabilityDenied
    );
    install_grant(
        &mut store,
        &manifest,
        "org.example.extension",
        premise.fence().extension_generation(),
    );
    let admitted =
        admit_activation(&premise, &dispatch, &store, FrameLimits::defaults()).unwrap();
    assert_eq!(admitted.activation_id(), ACTIVATION_ID);
    assert_eq!(admitted.module_id(), "timer");
    assert_eq!(admitted.request_id(), premise.fence().request_id());
    assert_eq!(admitted.frame_digest().to_string(), dispatch.frame_digest());
    assert_eq!(
        admitted.lease_token_digest().to_string(),
        Sha256Digest::compute(lease_token.expose_bytes()).to_canonical_string()
    );
    assert_eq!(admitted.replay_key().0, ACTIVATION_ID);
    let arguments = CanonicalJsonObject::try_from_iter([(
        "page_id".into(),
        CanonicalJsonValue::String("page".into()),
    )])
    .unwrap();
    let sdk_request = CapabilityRequest::new("host.block.get", arguments.clone()).unwrap();
    let admitted_request = admit_sdk_capability(&admitted, sdk_request).unwrap();
    assert_eq!(admitted_request.method(), "host.block.get");
    assert_eq!(admitted_request.arguments(), &arguments);
    let fabricated = CapabilityRequest::new("host.model.invoke", arguments.clone()).unwrap();
    assert_eq!(
        admit_sdk_capability(&admitted, fabricated).unwrap_err(),
        AdmissionError::CapabilityDenied
    );
    let result = ResultData::success(None, None);
    let receipt = admitted.result_receipt(&result).unwrap();
    assert_eq!(receipt.replay_key(), admitted.replay_key());
    assert_eq!(receipt.result_digest(), &result.digest().unwrap());
    let receipt_value: Value = serde_json::from_slice(receipt.bytes()).unwrap();
    assert_eq!(receipt_value["invocation"]["activation_id"], ACTIVATION_ID);
    assert_eq!(
        receipt_value["invocation"]["frame_digest"],
        dispatch.frame_digest()
    );
    assert_eq!(receipt_value["result"]["payload"]["status"], "success");
    assert_eq!(
        canonicalize(&receipt_value).unwrap().0.as_bytes(),
        receipt.bytes()
    );

    let authority = store.authenticated_host_connection().unwrap();
    store
        .revoke_host_capability_grant(&authority, "org.example.extension", "timer")
        .unwrap();
    assert_eq!(
        admit_activation(
            &premise,
            &dispatch,
            &store,
            FrameLimits::defaults()
        )
        .unwrap_err(),
        AdmissionError::CapabilityDenied
    );
    install_grant(
        &mut store,
        &manifest,
        "org.other.extension",
        premise.fence().extension_generation(),
    );
    assert_eq!(
        admit_activation(
            &premise,
            &dispatch,
            &store,
            FrameLimits::defaults()
        )
        .unwrap_err(),
        AdmissionError::CapabilityDenied
    );
    install_grant(
        &mut store,
        &manifest,
        "org.example.extension",
        premise.fence().extension_generation() + 1,
    );
    assert_eq!(
        admit_activation(
            &premise,
            &dispatch,
            &store,
            FrameLimits::defaults()
        )
        .unwrap_err(),
        AdmissionError::CapabilityDenied
    );
    install_grant(
        &mut store,
        &manifest,
        "org.example.extension",
        premise.fence().extension_generation(),
    );
    let replay = {
        drop(store);
        let mut engine = RuntimeTransactionEngine::new(&mut connection).unwrap();
        engine
            .dispatch_execution(&premise, "g2-dispatch-replay", &lease_token, &input())
            .unwrap()
    };
    let store = SqliteCoreStore::new(&mut connection).unwrap();
    let replayed =
        admit_activation(&premise, &replay, &store, FrameLimits::defaults()).unwrap();
    assert_eq!(replayed.replay_key(), admitted.replay_key());
    assert_eq!(replayed.frame_digest(), admitted.frame_digest());
    assert_eq!(replay.transition().state, dispatch.transition().state);
    let replay_receipt = replayed.result_receipt(&result).unwrap();
    assert_eq!(replay_receipt.replay_key(), receipt.replay_key());
    assert_eq!(replay_receipt.result_digest(), receipt.result_digest());
    assert_eq!(replay_receipt.receipt_digest(), receipt.receipt_digest());
}
