use std::collections::BTreeMap;

use dolly_canonical_json::canonicalize;
use dolly_core_reducer::{
    empty_core_snapshot, reduce, ActivationRecord, ActivationState, ApplyResultCommand,
    BuildManifestCommand, CoreCommand, EnvironmentInput, FenceCompleteCommand,
    HostFenceVerification, HostResultVerification, IssueLeaseCommand, ReceiveResultCommand,
    ReceiveResultStatus, StagedResult, SubscriptionRecord, Transition,
};
use serde_json::{json, Value};

const ACCEPTANCE_FIXTURE: &str = include_str!("fixtures/wp004_acceptance.json");

// In this matrix, a premise is descriptor data supplied as routing evidence;
// it is not Runtime authority and cannot grant a capability.
fn acceptance_case(id: &str) -> Value {
    let document: Value = serde_json::from_str(ACCEPTANCE_FIXTURE)
        .expect("WP-004 acceptance fixture must be valid JSON");
    assert_eq!(document["work_package"], "WP-004");
    assert!(!document["premise_definition"].as_str().unwrap().is_empty());
    document["cases"][id].clone()
}

fn canonical_digest(value: &Value) -> String {
    canonicalize(value)
        .expect("fixture value must be canonical JSON")
        .1
        .to_canonical_string()
}

fn manifest_with_digest(case: &Value) -> Value {
    let mut manifest = case["stimulus"]["manifest"].clone();
    let effective_config = manifest["effective_config"].clone();
    manifest["effective_config_digest"] = json!(canonical_digest(&effective_config));
    manifest
        .as_object_mut()
        .expect("manifest fixture must be an object")
        .remove("manifest_digest");
    let manifest_digest = canonical_digest(&manifest);
    manifest
        .as_object_mut()
        .expect("manifest fixture must be an object")
        .insert("manifest_digest".into(), json!(manifest_digest));
    manifest
}

fn base_input() -> EnvironmentInput {
    EnvironmentInput {
        now: "2025-01-01T00:00:00.000000Z".into(),
        ..Default::default()
    }
}

fn transition_value(transition: &Transition) -> Value {
    json!({
        "outcome": transition.outcome,
        "state": transition.state,
        "error": transition.error,
        "events": transition.events,
        "reply": transition.reply,
        "safety_stop": transition.safety_stop.as_ref().map(|stop| &stop.state),
    })
}

fn assert_case(id: &str, observed: &Value) {
    let case = acceptance_case(id);
    for assertion in case["expected"]["assertions"]
        .as_array()
        .expect("acceptance assertions must be an array")
    {
        let path = assertion["path"]
            .as_str()
            .expect("acceptance assertion path must be a string");
        let operation = assertion["op"]
            .as_str()
            .expect("acceptance assertion operation must be a string");
        let actual = observed.pointer(path);
        match operation {
            "equals" => assert_eq!(
                actual,
                Some(&assertion["value"]),
                "{id}: assertion at {path}"
            ),
            "not_equals" => assert_ne!(
                actual,
                Some(&assertion["value"]),
                "{id}: assertion at {path}"
            ),
            "absent" => assert!(
                actual.is_none(),
                "{id}: expected {path} to be absent, got {actual:?}"
            ),
            "count" => {
                let count = match actual {
                    Some(Value::Array(values)) => values.len(),
                    Some(Value::Object(values)) => values.len(),
                    _ => panic!("{id}: expected {path} to be an array or object"),
                };
                assert_eq!(
                    count,
                    assertion["value"]
                        .as_u64()
                        .expect("count assertion value must be an integer")
                        as usize,
                    "{id}: assertion at {path}"
                );
            }
            other => panic!("{id}: unsupported assertion operation {other}"),
        }
    }
}

fn issue_lease_command(value: &Value, activation_id: &str) -> IssueLeaseCommand {
    IssueLeaseCommand {
        command_id: value["command_id"].as_str().unwrap().into(),
        activation_id: activation_id.into(),
        lease_id: value["lease_id"].as_str().unwrap().into(),
        reservation_id: None,
        token_digest: value["token_digest"].as_str().unwrap().into(),
        extension_connection_id: value["extension_connection_id"].as_str().unwrap().into(),
        worker_epoch: value["worker_epoch"].as_i64().unwrap(),
        request_id: None,
        worker_epoch_id: None,
        incarnation_revision: None,
        extension_generation: value["extension_generation"].as_i64(),
    }
}

fn leased_state(
    activation_id: &str,
    lease_id: &str,
    manifest_digest: &str,
    token_digest: &str,
    extension_connection_id: &str,
    worker_epoch: i64,
    extension_generation: i64,
) -> dolly_core_reducer::CoreSnapshot {
    let mut state = empty_core_snapshot();
    state.activations.insert(
        activation_id.into(),
        ActivationRecord {
            state: ActivationState::Dispatched,
            attempt: 1,
            manifest: Some(json!({"manifest_digest": manifest_digest})),
            extension_generation: Some(extension_generation),
            ..Default::default()
        },
    );
    state.leases.insert(
        lease_id.into(),
        json!({
            "activation_id": activation_id,
            "token_digest": token_digest,
            "dispatch_state": "started",
            "attempt": 1,
            "extension_connection_id": extension_connection_id,
            "worker_epoch": worker_epoch,
            "extension_generation": extension_generation,
            "manifest_digest": manifest_digest
        }),
    );
    state
}

#[test]
fn manifest_rejects_untrusted_descriptor_field() {
    let id = "manifest_rejects_untrusted_descriptor_field";
    let case = acceptance_case(id);
    let mut input = base_input();
    input.graph_revision = Some(
        case["stimulus"]["expected_graph_revision"]
            .as_i64()
            .unwrap(),
    );
    input.descriptor_revision = Some(
        case["stimulus"]["expected_descriptor_revision"]
            .as_i64()
            .unwrap(),
    );
    let command = CoreCommand::BuildManifest(BuildManifestCommand {
        command_id: "build-manifest".into(),
        activation_id: case["stimulus"]["activation_id"].as_str().unwrap().into(),
        manifest: manifest_with_digest(&case),
        expected_graph_revision: Some(input.graph_revision.unwrap()),
        expected_descriptor_revision: Some(input.descriptor_revision.unwrap()),
    });

    let transition = reduce(&empty_core_snapshot(), &command, &input);
    assert_case(id, &transition_value(&transition));
}

#[test]
fn lease_replay_requires_extension_generation() {
    let id = "lease_replay_requires_extension_generation";
    let case = acceptance_case(id);
    let activation_id = case["stimulus"]["activation_id"].as_str().unwrap();
    let mut state = empty_core_snapshot();
    state.activations.insert(
        activation_id.into(),
        ActivationRecord {
            state: ActivationState::Ready,
            ..Default::default()
        },
    );
    let first_command = CoreCommand::IssueLease(issue_lease_command(
        &case["stimulus"]["first"],
        activation_id,
    ));
    let first = reduce(&state, &first_command, &base_input());
    let replay_command = CoreCommand::IssueLease(issue_lease_command(
        &case["stimulus"]["replay"],
        activation_id,
    ));
    let replay = reduce(&first.state, &replay_command, &base_input());

    assert_case(
        id,
        &json!({
            "first": transition_value(&first),
            "replay": transition_value(&replay)
        }),
    );
}

#[test]
fn invalid_result_quarantines_activation() {
    let id = "invalid_result_quarantines_activation";
    let case = acceptance_case(id);
    let stimulus = &case["stimulus"];
    let activation_id = stimulus["activation_id"].as_str().unwrap();
    let lease_id = stimulus["lease_id"].as_str().unwrap();
    let token_digest = stimulus["token_digest"].as_str().unwrap();
    let extension_connection_id = stimulus["extension_connection_id"].as_str().unwrap();
    let manifest_digest = stimulus["manifest_digest"].as_str().unwrap();
    let result_digest = stimulus["result_digest"].as_str().unwrap();
    let command = CoreCommand::ReceiveResult(ReceiveResultCommand {
        command_id: "receive-invalid-result".into(),
        activation_id: activation_id.into(),
        lease_id: lease_id.into(),
        result_digest: result_digest.into(),
        status: ReceiveResultStatus::Success,
        result: Some(stimulus["result"].clone()),
    });
    let input = EnvironmentInput {
        host_result_verification: Some(HostResultVerification {
            verified: true,
            activation_id: activation_id.into(),
            lease_id: lease_id.into(),
            token_digest: token_digest.into(),
            attempt: 1,
            extension_connection_id: extension_connection_id.into(),
            worker_epoch: stimulus["worker_epoch"].as_i64().unwrap(),
            extension_generation: Some(stimulus["extension_generation"].as_i64().unwrap()),
            manifest_digest: Some(manifest_digest.into()),
            result_digest: result_digest.into(),
            payload_valid: true,
        }),
        ..base_input()
    };
    let state = leased_state(
        activation_id,
        lease_id,
        manifest_digest,
        token_digest,
        extension_connection_id,
        stimulus["worker_epoch"].as_i64().unwrap(),
        stimulus["extension_generation"].as_i64().unwrap(),
    );

    let transition = reduce(&state, &command, &input);
    assert_case(id, &transition_value(&transition));
}
#[test]
fn durable_backpressure_retains_staged_result() {
    let id = "durable_backpressure_retains_staged_result";
    let case = acceptance_case(id);
    let stimulus = &case["stimulus"];
    let activation_id = stimulus["activation_id"].as_str().unwrap();
    let subscription_id = stimulus["subscription_id"].as_str().unwrap();
    let cursor = stimulus["cursor"].as_i64().unwrap();
    let mut state = empty_core_snapshot();
    let mut expected_cursors = BTreeMap::new();
    expected_cursors.insert(subscription_id.into(), cursor);
    state.subscriptions.insert(
        subscription_id.into(),
        SubscriptionRecord {
            cursor,
            ..Default::default()
        },
    );
    state.activations.insert(
        activation_id.into(),
        ActivationRecord {
            state: ActivationState::ResultStaged,
            attempt: 1,
            result_digest: Some(stimulus["result_digest"].as_str().unwrap().into()),
            staged_result: Some(StagedResult {
                expected_cursors,
                outputs: vec![json!({"block_id": "output-block", "block": {}})],
                admitted_pages: BTreeMap::new(),
                projected_admission_entries: stimulus["projected_admission_entries"]
                    .as_i64()
                    .unwrap(),
                page_limit: Some(stimulus["page_limit"].as_i64().unwrap()),
                validation: None,
            }),
            ..Default::default()
        },
    );
    let command = CoreCommand::ApplyResult(ApplyResultCommand {
        command_id: "apply-backpressured-result".into(),
        activation_id: activation_id.into(),
    });

    let transition = reduce(&state, &command, &base_input());
    assert_case(id, &transition_value(&transition));
}

#[test]
fn invalid_replay_evidence_fails_closed() {
    let id = "invalid_replay_evidence_fails_closed";
    let case = acceptance_case(id);
    let stimulus = &case["stimulus"];
    let activation_id = stimulus["activation_id"].as_str().unwrap();
    let module_id = stimulus["module_id"].as_str().unwrap();
    let storage_scope_id = stimulus["storage_scope_id"].as_str().unwrap();
    let manifest_digest = stimulus["manifest_digest"].as_str().unwrap();
    let extension_generation = stimulus["extension_generation"].as_i64().unwrap();
    let ledger = stimulus["ledger"].clone();
    let mut state = empty_core_snapshot();
    let record = stimulus["record"].clone();
    let evidence_digest = canonical_digest(&record);
    let mut retained_record = record;
    retained_record
        .as_object_mut()
        .expect("replay evidence record must be an object")
        .extend([
            ("evidence_digest".into(), json!(evidence_digest)),
            ("observation".into(), json!("succeeded")),
        ]);
    state.activations.insert(
        activation_id.into(),
        ActivationRecord {
            state: ActivationState::Fencing,
            attempt: 1,
            manifest: Some(json!({
                "module_id": module_id,
                "storage_scope_id": storage_scope_id,
                "manifest_digest": manifest_digest,
                "frozen_replay_contract": {
                    "mode": "fenced_replay",
                    "evidence": "activation_ledger",
                    "ledger": ledger
                }
            })),
            replay_evidence: Some(retained_record),
            extension_generation: Some(extension_generation),
            ..Default::default()
        },
    );
    state.leases.insert(
        "lease-3".into(),
        json!({
            "activation_id": activation_id,
            "attempt": 1,
            "dispatch_state": "started"
        }),
    );
    let input = EnvironmentInput {
        host_fence_verification: Some(HostFenceVerification {
            verified: true,
            activation_id: activation_id.into(),
            source_attempt: 1,
            execution_slot_empty: true,
            proof_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333"
                .into(),
        }),
        ..base_input()
    };
    let command = CoreCommand::FenceComplete(FenceCompleteCommand {
        command_id: "complete-invalid-replay-evidence-fence".into(),
        activation_id: activation_id.into(),
        retry_delay: 17,
    });

    let transition = reduce(&state, &command, &input);
    assert_case(id, &transition_value(&transition));
}

#[test]
fn acceptance_fixture_has_only_expected_cases() {
    let document: Value = serde_json::from_str(ACCEPTANCE_FIXTURE)
        .expect("WP-004 acceptance fixture must be valid JSON");
    let cases = document["cases"]
        .as_object()
        .expect("WP-004 acceptance cases must be an object");
    assert_eq!(cases.len(), 5);
    for id in [
        "manifest_rejects_untrusted_descriptor_field",
        "lease_replay_requires_extension_generation",
        "durable_backpressure_retains_staged_result",
        "invalid_result_quarantines_activation",
        "invalid_replay_evidence_fails_closed",
    ] {
        assert!(cases.contains_key(id), "missing acceptance case {id}");
    }
}
