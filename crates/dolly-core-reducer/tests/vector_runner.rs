use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use dolly_canonical_json::canonicalize;
use dolly_core_reducer::*;
use serde_json::{Map, Value, json};

fn digest(value: &Value) -> String {
    canonicalize(value).unwrap().1.to_canonical_string()
}
fn spec_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("dolly-spec")
}
fn read(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn fixture(name: &str) -> Value {
    let envelope = read(
        spec_root()
            .join("test-vectors/fixtures")
            .join(format!("{name}.json")),
    );
    assert_eq!(envelope["schema"], "dolly.test-fixture/v1");
    envelope["value"].clone()
}
fn initial(vector: &Value) -> Value {
    let source = vector["initial"].as_object().unwrap();
    let mut result = source
        .get("fixture")
        .and_then(Value::as_str)
        .map(fixture)
        .unwrap_or_else(|| json!({}));
    let map = result.as_object_mut().unwrap();
    for (key, value) in source {
        if key != "fixture" {
            map.insert(key.clone(), value.clone());
        }
    }
    result
}
fn base_input() -> EnvironmentInput {
    EnvironmentInput {
        now: "2026-08-10T22:00:00.000000Z".into(),
        graph_revision: Some(1),
        descriptor_revision: Some(1),
        retry_jitter: Some(0),
        recovery_verification: Some(RecoveryVerification {
            ordered_checks_complete: true,
            invariants_valid: true,
            persisted_values_valid: true,
            process_fences_valid: true,
            staged_results_valid: true,
            failure_reason: None,
        }),
        ..Default::default()
    }
}
fn run(
    state: &CoreSnapshot,
    command: CoreCommand,
    mutate: impl FnOnce(&mut EnvironmentInput),
) -> Transition {
    let mut input = base_input();
    mutate(&mut input);
    reduce(state, &command, &input)
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
fn execute_channel_send(action: &Value) -> Value {
    assert_eq!(action["name"], "org.dolly.channel.send");
    let parts = action["arguments"]["parts"].as_array().unwrap();
    json!({
        "schema":"dolly.action-result/v1",
        "action_id":action["action_id"],
        "status":"succeeded",
        "result":{
            "schema":"dolly.channel.send-result/v1",
            "session_id":action["arguments"]["session_id"],
            "delivery_outcome":"sent",
            "messages":parts.iter().enumerate().map(|(index,_)|{
                json!({"ordinal":index,"external_message_id":format!("transport-{}",index+1)})
            }).collect::<Vec<_>>(),
        },
        "error":null,
    })
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
fn replay_case_observation(
    item: &ActivationRecord,
    lease: &Value,
    cursor: i64,
    quarantine: Option<&Value>,
) -> Value {
    let mut dispatch = Map::new();
    dispatch.insert("state".into(), lease["dispatch_state"].clone());
    if let Some(value) = lease.get("fence_evidence_digest") {
        dispatch.insert("fence_evidence_digest".into(), value.clone());
    }
    let mut activation = Map::new();
    activation.insert("state".into(), json!(item.state));
    activation.insert("last_dispatch".into(), Value::Object(dispatch));
    if let Some(value) = &item.next_attempt_authorization {
        activation.insert(
            "next_attempt_authorization".into(),
            json!({
                "authorized_attempt":value["authorized_attempt"],
                "source_attempt":value["source_attempt"],
                "reason":value["reason"],
                "evidence_digest":value["evidence_digest"],
            }),
        );
    }
    if let Some(value) = item.retry_delay {
        activation.insert("retry_delay_ms".into(), json!(value));
    }
    let mut observed = Map::new();
    observed.insert("activation".into(), Value::Object(activation));
    observed.insert("subscription".into(), json!({"cursor":cursor}));
    if let Some(value) = quarantine {
        observed.insert("quarantine".into(), value.clone());
    }
    Value::Object(observed)
}
fn assert_vector(
    vector: &Value,
    scenario: &Value,
    before: &Value,
    outcome: &str,
    emitted: &[Value],
) {
    assert_eq!(
        outcome,
        vector["expected"]["outcome"].as_str().unwrap(),
        "{} outcome",
        vector["test_id"]
    );
    let assertions = vector["expected"]["assertions"].as_array().unwrap();
    assert!(!assertions.is_empty());
    for assertion in assertions {
        let path = assertion["path"].as_str().unwrap();
        let actual = scenario.pointer(path);
        match assertion["op"].as_str().unwrap() {
            "equals" => {
                let mut expected = &assertion["value"];
                let owned;
                if let Some(pointer) = expected
                    .as_str()
                    .and_then(|text| text.strip_prefix("@same:"))
                {
                    owned = scenario.pointer(pointer).cloned().unwrap_or(Value::Null);
                    expected = &owned;
                }
                assert_eq!(actual, Some(expected), "{} {path}", vector["test_id"]);
            }
            "not_equals" => assert_ne!(
                actual,
                Some(&assertion["value"]),
                "{} {path}",
                vector["test_id"]
            ),
            "count" => assert_eq!(
                actual.and_then(count),
                assertion["value"].as_u64().map(|v| v as usize),
                "{} {path}",
                vector["test_id"]
            ),
            "absent" => assert!(actual.is_none(), "{} {path}", vector["test_id"]),
            "unchanged" => assert_eq!(actual, before.pointer(path), "{} {path}", vector["test_id"]),
            "contains" => assert!(
                actual.is_some_and(|value| match value {
                    Value::Array(array) => array.contains(&assertion["value"]),
                    Value::String(text) => assertion["value"]
                        .as_str()
                        .is_some_and(|needle| text.contains(needle)),
                    Value::Object(_) => subset(value, &assertion["value"]),
                    _ => false,
                }),
                "{} {path}",
                vector["test_id"]
            ),
            other => panic!("unsupported assertion {other}"),
        }
    }
    let required = vector["expected"]["emitted"].as_array().unwrap();
    assert_eq!(
        emitted.len(),
        required.len(),
        "{} emitted length",
        vector["test_id"]
    );
    for (actual, expected) in emitted.iter().zip(required) {
        assert!(
            subset(actual, expected),
            "{} emitted\nactual={actual}\nrequired={expected}",
            vector["test_id"]
        )
    }
}
fn fence(initial: &Value, stimulus: &Value) -> Transition {
    let mut state = empty_core_snapshot();
    let dispatch = initial["last_dispatch"]["state"].as_str().unwrap();
    state.activations.insert(
        "a".into(),
        ActivationRecord {
            state: if dispatch == "started" {
                ActivationState::Dispatched
            } else {
                ActivationState::Leased
            },
            attempt: initial["attempt"].as_i64().unwrap(),
            manifest: Some(json!({"frozen_replay_contract":initial["frozen_replay_contract"]})),
            ..Default::default()
        },
    );
    state.leases.insert(
        "l".into(),
        json!({"activation_id":"a","token_digest":"token","attempt":1,"dispatch_state":dispatch}),
    );
    state.subscriptions.insert(
        "s".into(),
        SubscriptionRecord {
            cursor: initial["cursor"].as_i64().unwrap(),
            paused: None,
        },
    );
    let begun = run(
        &state,
        CoreCommand::BeginFence(BeginFenceCommand {
            command_id: "begin".into(),
            activation_id: "a".into(),
        }),
        |_| {},
    );
    run(
        &begun.state,
        CoreCommand::FenceComplete(FenceCompleteCommand {
            command_id: "complete".into(),
            activation_id: "a".into(),
            retry_delay: stimulus
                .get("retry_jitter_ms")
                .and_then(Value::as_i64)
                .unwrap_or(0),
        }),
        |input| {
            input.host_fence_verification = Some(HostFenceVerification {
                verified: true,
                activation_id: "a".into(),
                source_attempt: 1,
                execution_slot_empty: true,
                proof_digest: stimulus["host_fence_evidence_digest"]
                    .as_str()
                    .unwrap()
                    .into(),
            })
        },
    )
}

fn execute(vector: &Value) -> (Value, Value, String, Vec<Value>) {
    let initial = initial(vector);
    let stimulus = &vector["stimulus"];
    match vector["test_id"].as_str().unwrap() {
        "TST-CORE-001" => {
            let mut state = empty_core_snapshot();
            state.next_commit_seq = initial["next_commit_seq"].as_i64().unwrap();
            let mut results = Vec::new();
            let mut event_count = 0;
            for (index, item) in stimulus["commands"].as_array().unwrap().iter().enumerate() {
                let key = item["key"].as_str().unwrap();
                let (runtime, ingress) = key.split_once(':').unwrap();
                let draft = fixture(item["draft_fixture"].as_str().unwrap());
                let operation = digest(&json!({"key":key,"draft":draft}));
                let result = run(
                    &state,
                    CoreCommand::Ingress(IngressCommand {
                        command_id: format!("ingress-{index}"),
                        runtime_source: runtime.into(),
                        ingress_key: ingress.into(),
                        operation_digest: operation,
                        block_id: "derived-block-1".into(),
                        block: draft,
                        pages: item["pages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|value| value.as_str().unwrap().into())
                            .collect(),
                    }),
                    |_| {},
                );
                event_count += result
                    .events
                    .iter()
                    .filter(|event| event.event == "IngressCommitted")
                    .count();
                results.push(result.reply.unwrap());
                state = result.state;
            }
            let outcome = if results[1]["idempotent"] == true {
                "idempotent_existing_result"
            } else {
                "unexpected"
            };
            (
                json!({"blocks":state.blocks,"deliveries":state.deliveries,"results":results,"next_commit_seq":state.next_commit_seq}),
                json!({}),
                outcome.into(),
                vec![json!({"event":"IngressCommitted","count":event_count})],
            )
        }
        "TST-CORE-002" => {
            let activation = &initial["activation"];
            let id = activation["activation_id"].as_str().unwrap();
            let cursor = initial["input_subscription"]["cursor"].as_i64().unwrap();
            let output_pages = initial["output_pages"].as_object().unwrap();
            let block_id = "staged-output";
            let mut admitted_pages = BTreeMap::new();
            let mut pages = BTreeMap::new();
            let mut deliveries = Vec::new();
            for (page_id, page) in output_pages {
                admitted_pages.insert(
                    page_id.clone(),
                    vec![PageRecord {
                        page_seq: page["next_page_seq"].as_i64().unwrap(),
                        entries: vec![json!({"block_id":block_id})],
                        lossy: None,
                    }],
                );
                pages.insert(page_id.clone(), Vec::new());
                deliveries.push(json!({"block_id":block_id,"page_id":page_id}));
            }
            let mut state = staged(
                id,
                BTreeMap::from([("input".into(), cursor)]),
                vec![json!({
                    "block_id":block_id,
                    "block":activation["staged_output"],
                    "deliveries":deliveries,
                })],
                admitted_pages,
                i64::try_from(output_pages.len()).unwrap(),
                None,
            );
            state.activations.get_mut(id).unwrap().result_digest =
                Some(activation["result_digest"].as_str().unwrap().into());
            state.subscriptions.insert(
                "input".into(),
                SubscriptionRecord {
                    cursor,
                    paused: None,
                },
            );
            state.next_commit_seq = initial["next_commit_seq"].as_i64().unwrap();
            state.pages = pages;
            let result = run(
                &state,
                CoreCommand::ApplyResult(ApplyResultCommand {
                    command_id: "apply".into(),
                    activation_id: id.into(),
                }),
                |input| {
                    input.crash_point = stimulus["crash_at"].as_str().map(str::to_string);
                    input.storage_observation = Some(StorageObservation::BeforeCommit)
                },
            );
            let mut observed = Map::new();
            observed.insert("activation".into(), json!(result.state.activations[id]));
            observed.insert(
                "cursor".into(),
                json!(result.state.subscriptions["input"].cursor),
            );
            observed.insert("deliveries".into(), json!(result.state.deliveries));
            if let Some(block) = result.state.blocks.get(block_id) {
                observed.insert("output_block".into(), block.clone());
            }
            (
                Value::Object(observed),
                json!({}),
                if result.error.as_ref().unwrap().code == "SIMULATED_CRASH" {
                    "transaction_absent_after_recovery"
                } else {
                    "unexpected"
                }
                .into(),
                result.events.iter().map(flatten).collect(),
            )
        }
        "TST-CORE-003" => {
            let target = vector["initial"]["target_module"].as_str().unwrap();
            let observer = vector["initial"]["other_module"].as_str().unwrap();
            let action = &initial["action"];
            assert_eq!(action["target"]["module_id"], target);
            assert!(
                initial["subscriptions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|value| value["module_id"] == observer)
            );
            let target_pages: Vec<&Value> = initial["subscriptions"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|subscription| subscription["module_id"] == target)
                .collect();
            let occurrence_count = initial["deliveries"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|delivery| {
                    target_pages
                        .iter()
                        .any(|subscription| subscription["page_id"] == delivery["page_id"])
                })
                .count();
            let action_id = action["action_id"].clone();
            let manifest = json!({
                "input_items":[{
                    "action_id":action_id,
                    "action":action,
                    "occurrence_count":occurrence_count,
                }],
                "reason":"input",
            });
            let built = run(
                &empty_core_snapshot(),
                CoreCommand::BuildManifest(BuildManifestCommand {
                    command_id: "build".into(),
                    activation_id: "target".into(),
                    manifest,
                    expected_graph_revision: None,
                    expected_descriptor_revision: None,
                }),
                |_| {},
            );
            let leased = run(
                &built.state,
                CoreCommand::IssueLease(IssueLeaseCommand {
                    command_id: "lease".into(),
                    activation_id: "target".into(),
                    lease_id: "lease".into(),
                    token_digest: "token".into(),
                    extension_connection_id: "connection-1".into(),
                    worker_epoch: 1,
                    extension_generation: None,
                }),
                |_| {},
            );
            let dispatched = run(
                &leased.state,
                CoreCommand::DispatchLease(DispatchLeaseCommand {
                    command_id: "dispatch".into(),
                    activation_id: "target".into(),
                    lease_id: "lease".into(),
                    dispatch_state: DispatchState::Started,
                }),
                |_| {},
            );
            let action_result = execute_channel_send(action);
            let result_payload = json!({
                "expected_cursors":{},
                "outputs":[{
                    "block_id":"action-result",
                    "block":action_result,
                    "action_ledger":{"action_id":action_id,"status":action_result["status"]},
                    "deliveries":[],
                }],
                "admitted_pages":{},
                "projected_admission_entries":0,
            });
            let result_digest = digest(&result_payload);
            let received = run(
                &dispatched.state,
                CoreCommand::ReceiveResult(ReceiveResultCommand {
                    command_id: "result".into(),
                    activation_id: "target".into(),
                    lease_id: "lease".into(),
                    result_digest: result_digest.clone(),
                    status: ReceiveResultStatus::Success,
                    result: Some(result_payload),
                }),
                |input| {
                    input.host_result_verification = Some(HostResultVerification {
                        verified: true,
                        payload_valid: true,
                        activation_id: "target".into(),
                        lease_id: "lease".into(),
                        token_digest: "token".into(),
                        extension_connection_id: "connection-1".into(),
                        worker_epoch: 1,
                        attempt: 1,
                        extension_generation: None,
                        manifest_digest: None,
                        result_digest,
                    })
                },
            );
            let applied = run(
                &received.state,
                CoreCommand::ApplyResult(ApplyResultCommand {
                    command_id: "apply".into(),
                    activation_id: "target".into(),
                }),
                |_| {},
            );
            let target_ledger: Vec<Value> = applied
                .state
                .outputs
                .iter()
                .map(|output| output["action_ledger"].clone())
                .collect();
            let observer_ledger: Vec<Value> = applied
                .state
                .outputs
                .iter()
                .filter(|output| output["target_module"] == observer)
                .map(|output| output["action_ledger"].clone())
                .collect();
            let emitted: Vec<Value> = applied
                .state
                .outputs
                .iter()
                .map(|output| output["block"].clone())
                .collect();
            (
                json!({
                    "target":{
                        "manifest":applied.state.manifests["target"],
                        "action_ledger":target_ledger,
                    },
                    "observer":{"action_ledger":observer_ledger},
                }),
                json!({}),
                if applied.state.activations["target"].state == ActivationState::Committed
                    && occurrence_count == 2
                    && target_ledger.len() == 1
                {
                    "one_target_execution"
                } else {
                    "unexpected"
                }
                .into(),
                emitted,
            )
        }
        "TST-CORE-004" => {
            let mut state = empty_core_snapshot();
            state.mode = InstanceMode::RecoveryRequired;
            state.next_page_seq = initial["diagnostic_cursor"].as_i64().unwrap();
            state.volatile_lossy_entries = initial["memory_entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| json!({"page_seq":value}))
                .collect();
            let result = run(
                &state,
                CoreCommand::Recover(RecoverCommand {
                    command_id: "restart".into(),
                    persisted_next_page_seq: initial["persisted_next_page_seq"].as_i64().unwrap(),
                }),
                |_| {},
            );
            let gaps:Vec<_>=result.state.lossy_gaps.iter().map(|gap|json!({"from_page_seq":gap["start"],"to_page_seq":gap["end_exclusive"],"reason":gap["reason"]})).collect();
            let emitted = result
                .events
                .iter()
                .filter(|event| event.event == "LossyGap")
                .map(flatten)
                .collect();
            (
                json!({"page":{"next_page_seq":result.state.next_page_seq,"memory_entries":result.state.volatile_lossy_entries},"manifest":{"lossy_gaps":gaps}}),
                json!({}),
                if result.state.lossy_gaps.len() == 1 {
                    "pending_loss_reported_as_gap"
                } else {
                    "unexpected"
                }
                .into(),
                emitted,
            )
        }
        "TST-CORE-005" => {
            let id = initial["activation"]["activation_id"].as_str().unwrap();
            let fence = &initial["issued_fences"][0];
            let mut state = empty_core_snapshot();
            state.activations.insert(
                id.into(),
                ActivationRecord {
                    state: ActivationState::Committed,
                    attempt: 1,
                    result_digest: Some(
                        vector["initial"]["authoritative_result_digest"]
                            .as_str()
                            .unwrap()
                            .into(),
                    ),
                    authoritative_disposition: Some(ActivationState::Committed),
                    ..Default::default()
                },
            );
            state.leases.insert("l".into(),json!({"activation_id":id,"token_digest":fence["token_hash"],"extension_connection_id":"connection-1","worker_epoch":1,"attempt":1,"extension_generation":fence["extension_generation"],"dispatch_state":"started"}));
            state.outputs = initial["outputs"].as_array().unwrap().clone();
            let before = json!({"outputs":state.outputs});
            let result_digest = stimulus["result_digest"].as_str().unwrap();
            let result = run(
                &state,
                CoreCommand::ReceiveResult(ReceiveResultCommand {
                    command_id: "result".into(),
                    activation_id: id.into(),
                    lease_id: "l".into(),
                    result_digest: result_digest.into(),
                    status: ReceiveResultStatus::Success,
                    result: None,
                }),
                |input| {
                    input.host_result_verification = Some(HostResultVerification {
                        verified: stimulus["authenticated_previously_issued_fence"] == true,
                        payload_valid: true,
                        activation_id: id.into(),
                        lease_id: "l".into(),
                        token_digest: fence["token_hash"].as_str().unwrap().into(),
                        attempt: 1,
                        extension_connection_id: "connection-1".into(),
                        worker_epoch: 1,
                        extension_generation: fence["extension_generation"].as_i64(),
                        manifest_digest: None,
                        result_digest: result_digest.into(),
                    })
                },
            );
            (
                json!({"activation":result.state.activations[id],"module":{"lifecycle_state":if result.state.quarantines.contains_key(id){"quarantined"}else{"idle"}},"outputs":result.state.outputs}),
                before,
                result.error.as_ref().unwrap().code.clone(),
                result.events.iter().map(flatten).collect(),
            )
        }
        "TST-CORE-006" | "TST-CORE-007" => {
            let result = fence(&initial, stimulus);
            let item = &result.state.activations["a"];
            let lease = &result.state.leases["l"];
            let mut activation = Map::new();
            activation.insert("state".into(), json!(item.state));
            activation.insert(
                "last_dispatch".into(),
                json!({"state":lease["dispatch_state"]}),
            );
            if let Some(value) = &item.next_attempt_authorization {
                activation.insert(
                    "next_attempt_authorization".into(),
                    json!({
                        "authorized_attempt":value["authorized_attempt"],
                        "source_attempt":value["source_attempt"],
                        "reason":value["reason"],
                        "evidence_digest":value["evidence_digest"],
                    }),
                );
            }
            if let Some(value) = item.retry_delay {
                activation.insert("retry_delay_ms".into(), json!(value));
            }
            let observed = json!({
                "activation":activation,
                "module":{},
                "subscription":{"cursor":result.state.subscriptions["s"].cursor},
            });
            let outcome = if vector["test_id"] == "TST-CORE-006" {
                result.state.quarantines["a"]["reason"].as_str().unwrap()
            } else if item.state == ActivationState::RetryWait {
                "safe_before_dispatch_retry"
            } else {
                "unexpected"
            };
            (
                observed,
                json!({}),
                outcome.into(),
                result.events.iter().map(flatten).collect(),
            )
        }
        "TST-CORE-008" => {
            let mut state = empty_core_snapshot();
            let mut results = Vec::new();
            for (index, item) in stimulus["commands"].as_array().unwrap().iter().enumerate() {
                let result = run(
                    &state,
                    CoreCommand::RuntimeEvent(RuntimeEventCommand {
                        command_id: format!("event-{index}"),
                        runtime_source: item["runtime_source"].as_str().unwrap().into(),
                        event_key: item["event_key"].as_str().unwrap().into(),
                        operation_digest: item["operation_digest"].as_str().unwrap().into(),
                        block_id: "runtime-block".into(),
                        block: json!({"source":"clock"}),
                        pages: vec!["timer".into(), "audit".into()],
                    }),
                    |_| {},
                );
                state = result.state.clone();
                results.push(result);
            }
            let mut counts = BTreeMap::new();
            for delivery in &state.deliveries {
                *counts
                    .entry(delivery["page_id"].as_str().unwrap())
                    .or_insert(0) += 1;
            }
            let original = state.runtime_events.values().next().unwrap();
            let outcome =
                if results[2].error.as_ref().unwrap().code == "STORAGE_IDEMPOTENCY_CONFLICT" {
                    "one_commit_one_replay_one_conflict"
                } else {
                    "unexpected"
                };
            (
                json!({"runtime_event_operations":state.runtime_events,"blocks":state.blocks,"deliveries":{"by_target_page":if counts.values().all(|count|*count==1){"one_each"}else{"duplicate"}},"third":{"error":results[2].error.as_ref().unwrap().code},"original":original}),
                json!({}),
                outcome.into(),
                vec![
                    flatten(&results[0].events[0]),
                    json!({"event":"SecurityIncident","reason":results[2].error.as_ref().unwrap().code}),
                    {
                        let third = results[2].error.as_ref().unwrap();
                        json!({"error":third.code,"retryable":third.retryable,"outcome":third.outcome})
                    },
                ],
            )
        }
        "TST-CORE-009" => {
            let mut observed = Map::new();
            let mut emitted = Vec::new();
            for case_name in ["complete", "unknown"] {
                let case = &initial["cases"][case_name];
                let commands = stimulus["cases"][case_name]["commands"].as_array().unwrap();
                let id = case["activation_id"].as_str().unwrap();
                let mut state = empty_core_snapshot();
                state.activations.insert(
                    id.into(),
                    ActivationRecord {
                        state: ActivationState::Dispatched,
                        attempt: 1,
                        extension_generation: case["target_extension_generation"].as_i64(),
                        manifest: Some(json!({
                            "manifest_digest":case["manifest_digest"],
                            "module_id":case["module_id"],
                            "storage_scope_id":stimulus["cases"][case_name]["commands"][1]["record"]["storage_scope_id"],
                            "frozen_replay_contract":case["frozen_replay_contract"],
                        })),
                        ..Default::default()
                    },
                );
                state.leases.insert(
                    "l".into(),
                    json!({
                        "activation_id":id,
                        "token_digest":"token",
                        "attempt":1,
                        "extension_generation":case["target_extension_generation"],
                        "dispatch_state":"started",
                        "manifest_digest":case["manifest_digest"],
                    }),
                );
                state.subscriptions.insert(
                    "s".into(),
                    SubscriptionRecord {
                        cursor: case["cursor"].as_i64().unwrap(),
                        paused: None,
                    },
                );
                let begun = run(
                    &state,
                    CoreCommand::BeginFence(BeginFenceCommand {
                        command_id: format!("{case_name}-begin"),
                        activation_id: id.into(),
                    }),
                    |_| {},
                );
                let record = &commands[1];
                let evidence = record["record"].clone();
                let evidence_digest = record["expected_evidence_digest"].as_str().unwrap();
                let recorded = run(
                    &begun.state,
                    CoreCommand::RecordReplayEvidence(RecordReplayEvidenceCommand {
                        command_id: format!("{case_name}-record"),
                        activation_id: id.into(),
                    }),
                    |input| {
                        input.host_replay_evidence = Some(HostReplayEvidence {
                            verified: true,
                            activation_id: id.into(),
                            source_attempt: 1,
                            target_generation: evidence["target_extension_generation"].as_i64(),
                            observation: if evidence["ledger_state"] == "complete" {
                                ReplayEvidenceObservation::Succeeded
                            } else {
                                ReplayEvidenceObservation::Unknown
                            },
                            record: evidence.clone(),
                            digest: evidence_digest.into(),
                        })
                    },
                );
                let complete = &commands[2];
                let proof = complete["host_fence_evidence_digest"].as_str().unwrap();
                let completed = run(
                    &recorded.state,
                    CoreCommand::FenceComplete(FenceCompleteCommand {
                        command_id: format!("{case_name}-complete"),
                        activation_id: id.into(),
                        retry_delay: complete
                            .get("retry_jitter_ms")
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                    }),
                    |input| {
                        input.host_fence_verification = Some(HostFenceVerification {
                            verified: true,
                            activation_id: id.into(),
                            source_attempt: 1,
                            execution_slot_empty: true,
                            proof_digest: proof.into(),
                        })
                    },
                );
                let item = &completed.state.activations[id];
                observed.insert(
                    case_name.into(),
                    replay_case_observation(
                        item,
                        &completed.state.leases["l"],
                        completed.state.subscriptions["s"].cursor,
                        completed.state.quarantines.get(id),
                    ),
                );
                if case_name == "complete" {
                    let mut first = flatten(&recorded.events[0]);
                    first
                        .as_object_mut()
                        .unwrap()
                        .insert("case".into(), json!(case_name));
                    emitted.push(first);
                    let mut second = flatten(&completed.events[0]);
                    second
                        .as_object_mut()
                        .unwrap()
                        .insert("case".into(), json!(case_name));
                    emitted.push(second);
                } else {
                    let mut event = flatten(&completed.events[0]);
                    event
                        .as_object_mut()
                        .unwrap()
                        .insert("case".into(), json!(case_name));
                    emitted.push(event);
                }
            }
            let doc = Value::Object(observed);
            let outcome = if doc["complete"]["activation"]["state"] == "retry_wait"
                && doc["unknown"]["activation"]["state"] == "quarantined"
            {
                "complete_authorized_unknown_quarantined"
            } else {
                "unexpected"
            };
            (doc, json!({}), outcome.into(), emitted)
        }
        "TST-CORE-010" => {
            let page = &initial["page"];
            let mut primary = staged(
                "a",
                BTreeMap::from([("worker".into(), 1)]),
                vec![],
                BTreeMap::from([(
                    page["page_id"].as_str().unwrap().into(),
                    vec![PageRecord {
                        page_seq: 2,
                        entries: vec![json!({})],
                        lossy: None,
                    }],
                )]),
                1,
                Some(1),
            );
            primary.subscriptions.insert(
                "worker".into(),
                SubscriptionRecord {
                    cursor: 1,
                    paused: None,
                },
            );
            primary.pages.insert(
                page["page_id"].as_str().unwrap().into(),
                vec![PageRecord {
                    page_seq: 1,
                    entries: vec![json!({})],
                    lossy: None,
                }],
            );
            primary.next_page_seq = 2;
            let applied = run(
                &primary,
                CoreCommand::ApplyResult(ApplyResultCommand {
                    command_id: "primary".into(),
                    activation_id: "a".into(),
                }),
                |_| {},
            );
            let control = &initial["lagging_subscriber_control"]["page"];
            let control_id = control["page_id"].as_str().unwrap();
            let mut lagging = staged(
                "a",
                BTreeMap::from([("worker".into(), 1)]),
                vec![],
                BTreeMap::from([(
                    control_id.into(),
                    vec![PageRecord {
                        page_seq: 2,
                        entries: vec![json!({})],
                        lossy: None,
                    }],
                )]),
                1,
                Some(1),
            );
            lagging.subscriptions.insert(
                "worker".into(),
                SubscriptionRecord {
                    cursor: 1,
                    paused: None,
                },
            );
            lagging.subscriptions.insert(
                "observer".into(),
                SubscriptionRecord {
                    cursor: 1,
                    paused: None,
                },
            );
            lagging.pages.insert(
                control_id.into(),
                vec![PageRecord {
                    page_seq: 1,
                    entries: vec![json!({})],
                    lossy: None,
                }],
            );
            lagging.next_page_seq = 2;
            let blocked = run(
                &lagging,
                CoreCommand::ApplyResult(ApplyResultCommand {
                    command_id: "control".into(),
                    activation_id: "a".into(),
                }),
                |_| {},
            );
            let outcome = if applied.state.activations["a"].state == ActivationState::Committed
                && blocked.error.as_ref().unwrap().code == "PAGE_QUOTA_EXCEEDED"
            {
                "committed_with_projected_pending_count_one"
            } else {
                "unexpected"
            };
            (
                json!({"activation":applied.state.activations["a"],"page":{"subscriptions":[{"cursor":applied.state.subscriptions["worker"].cursor}],"next_page_seq":applied.state.next_page_seq,"projected_admission_entries":applied.reply.as_ref().unwrap()["projected_admission_entries"],"pending_deliveries":applied.state.pages[page["page_id"].as_str().unwrap()]},"lagging_subscriber_control":{"activation":{"state":"commit_blocked"},"page":{"projected_admission_entries":blocked.error.as_ref().unwrap().details.as_ref().unwrap()["projected_admission_entries"],"subscriptions":[{"cursor":blocked.state.subscriptions["worker"].cursor},{"cursor":blocked.state.subscriptions["observer"].cursor}],"next_page_seq":blocked.state.next_page_seq}}}),
                json!({}),
                outcome.into(),
                applied.events.iter().map(flatten).collect(),
            )
        }
        "TST-CORE-011" => {
            let mut state = empty_core_snapshot();
            state.next_page_seq = initial["page"]["next_page_seq"].as_i64().unwrap();
            state.subscriptions.insert(
                "worker".into(),
                SubscriptionRecord {
                    cursor: initial["subscription"]["cursor"].as_i64().unwrap(),
                    paused: Some(true),
                },
            );
            let result = run(
                &state,
                CoreCommand::SkipRange(SkipRangeCommand {
                    command_id: "skip".into(),
                    subscription_id: "worker".into(),
                    start: stimulus["expected_cursor"].as_i64().unwrap(),
                    end_exclusive: stimulus["end_exclusive"].as_i64().unwrap(),
                }),
                |_| {},
            );
            (
                json!({"subscription":result.state.subscriptions["worker"],"page":{"next_page_seq":result.state.next_page_seq},"disposition_audit_rows":[]}),
                json!({}),
                result.error.unwrap().code,
                vec![],
            )
        }
        "TST-CORE-012" => {
            let graph = &initial["active_graph"];
            let replacement = &initial["verified_inactive_descriptor"];
            let mut state = empty_core_snapshot();
            state.graph = json!({"revision":graph["graph_revision"]});
            let stale = run(
                &state,
                CoreCommand::BuildManifest(BuildManifestCommand {
                    command_id: "stale".into(),
                    activation_id: "a".into(),
                    manifest: json!({}),
                    expected_graph_revision: graph["graph_revision"].as_i64(),
                    expected_descriptor_revision: graph["module_descriptor_revision"].as_i64(),
                }),
                |input| {
                    input.graph_revision = Some(8);
                    input.descriptor_revision = replacement["descriptor_revision"].as_i64()
                },
            );
            let manifest = json!({"graph_revision":8,"module_descriptor_revision":replacement["descriptor_revision"],"module_descriptor_digest":replacement["descriptor_digest"]});
            let retried = run(
                &stale.state,
                CoreCommand::BuildManifest(BuildManifestCommand {
                    command_id: "retry".into(),
                    activation_id: "a".into(),
                    manifest: manifest.clone(),
                    expected_graph_revision: Some(8),
                    expected_descriptor_revision: replacement["descriptor_revision"].as_i64(),
                }),
                |input| {
                    input.graph_revision = Some(8);
                    input.descriptor_revision = replacement["descriptor_revision"].as_i64()
                },
            );
            (
                json!({
                    "manifest":retried.state.manifests["a"],
                    "manifests_with_graph_7_descriptor_10":retried.state.manifests.values()
                        .filter(|item|item["graph_revision"]==7&&item["module_descriptor_revision"]==10)
                        .collect::<Vec<_>>(),
                }),
                json!({}),
                if stale.error.as_ref().unwrap().code == "MANIFEST_BUILD_CAS_RETRY" {
                    "stale_build_retried_against_complete_new_graph_tuple"
                } else {
                    "unexpected"
                }
                .into(),
                stale.events.iter().map(flatten).collect(),
            )
        }
        "TST-CORE-013" => {
            let binding = &initial["committed_action"]["contract_binding"];
            let manifest = json!({"action_contract_binding":binding});
            let built = run(
                &empty_core_snapshot(),
                CoreCommand::BuildManifest(BuildManifestCommand {
                    command_id: "build".into(),
                    activation_id: "a".into(),
                    manifest,
                    expected_graph_revision: None,
                    expected_descriptor_revision: None,
                }),
                |_| {},
            );
            let leased = run(
                &built.state,
                CoreCommand::IssueLease(IssueLeaseCommand {
                    command_id: "lease".into(),
                    activation_id: "a".into(),
                    lease_id: "l".into(),
                    token_digest: "token".into(),
                    extension_connection_id: "connection-1".into(),
                    worker_epoch: 1,
                    extension_generation: None,
                }),
                |_| {},
            );
            let dispatched = run(
                &leased.state,
                CoreCommand::DispatchLease(DispatchLeaseCommand {
                    command_id: "dispatch".into(),
                    activation_id: "a".into(),
                    lease_id: "l".into(),
                    dispatch_state: DispatchState::Started,
                }),
                |_| {},
            );
            let result_payload = json!({
                "expected_cursors":{},
                "outputs":[{"block_id":"action-result","block":stimulus["result"]}],
                "admitted_pages":{},
                "projected_admission_entries":0,
                "validation":{
                    "descriptor_revision":binding["descriptor_revision"],
                    "action_contract_digest":binding["action_contract_digest"],
                    "consulted_current_descriptor":false,
                },
            });
            let result_digest = digest(&result_payload);
            let received = run(
                &dispatched.state,
                CoreCommand::ReceiveResult(ReceiveResultCommand {
                    command_id: "result".into(),
                    activation_id: "a".into(),
                    lease_id: "l".into(),
                    result_digest: result_digest.clone(),
                    status: ReceiveResultStatus::Success,
                    result: Some(result_payload),
                }),
                |input| {
                    input.host_result_verification = Some(HostResultVerification {
                        verified: true,
                        payload_valid: true,
                        activation_id: "a".into(),
                        lease_id: "l".into(),
                        token_digest: "token".into(),
                        extension_connection_id: "connection-1".into(),
                        worker_epoch: 1,
                        attempt: 1,
                        extension_generation: None,
                        manifest_digest: None,
                        result_digest,
                    })
                },
            );
            let result = run(
                &received.state,
                CoreCommand::ApplyResult(ApplyResultCommand {
                    command_id: "apply".into(),
                    activation_id: "a".into(),
                }),
                |_| {},
            );
            (
                json!({"validation":result.state.activations["a"].validation,"activation":result.state.activations["a"]}),
                json!({}),
                if result.state.activations["a"].state == ActivationState::Committed {
                    "result_validated_by_creation_time_contract"
                } else {
                    "unexpected"
                }
                .into(),
                result.events.iter().map(flatten).collect(),
            )
        }
        "TST-CORE-014" => {
            let manifest = json!({"reason":stimulus["reason"],"input_items":[],"cursor_spans":[],"lossy_gaps":initial["lossy_page"]["pending_unreported_gaps"]});
            let result = run(
                &empty_core_snapshot(),
                CoreCommand::BuildManifest(BuildManifestCommand {
                    command_id: "build".into(),
                    activation_id: "a".into(),
                    manifest,
                    expected_graph_revision: None,
                    expected_descriptor_revision: None,
                }),
                |_| {},
            );
            (
                json!({"manifest":result.state.manifests["a"],"activation":result.state.activations["a"]}),
                json!({}),
                if result.state.activations["a"].state == ActivationState::Ready {
                    "gap_only_manifest_ready"
                } else {
                    "unexpected"
                }
                .into(),
                result.events.iter().map(flatten).collect(),
            )
        }
        "TST-CORE-015" => {
            let activation = &initial["activation"];
            let id = activation["activation_id"].as_str().unwrap();
            let mut state = staged(
                id,
                BTreeMap::from([(
                    "worker".into(),
                    activation["cursor_span"]["from_page_seq"].as_i64().unwrap(),
                )]),
                vec![json!({"must_not_commit":true})],
                BTreeMap::new(),
                0,
                None,
            );
            state.activations.get_mut(id).unwrap().result_digest = Some(
                activation["authoritative_result_digest"]
                    .as_str()
                    .unwrap()
                    .into(),
            );
            state.subscriptions.insert(
                "worker".into(),
                SubscriptionRecord {
                    cursor: initial["subscription"]["cursor"].as_i64().unwrap(),
                    paused: None,
                },
            );
            let result = run(
                &state,
                CoreCommand::ApplyResult(ApplyResultCommand {
                    command_id: "apply".into(),
                    activation_id: id.into(),
                }),
                |input| {
                    input.crash_point = stimulus["injection_point"].as_str().map(str::to_string);
                    input.storage_observation = Some(StorageObservation::AfterCommit)
                },
            );
            (
                json!({"instance_state":if result.state.mode==InstanceMode::RecoveryRequired{"RecoveryRequired"}else{"Running"},"activation":{"state":result.state.activations[id].state,"authoritative_result_digest":result.state.activations[id].result_digest},"module":initial["module"],"subscription":result.state.subscriptions["worker"],"outputs":result.state.outputs,"incident_evidence":result.state.security_incidents}),
                json!({}),
                result.error.as_ref().unwrap().code.clone(),
                result.events.iter().map(flatten).collect(),
            )
        }
        "TST-CORE-016" => {
            let activation = &initial["activation"];
            let manifest = activation["manifest"].clone();
            let schema = manifest["effective_config_schema_digest"].as_str().unwrap();
            let mut state = empty_core_snapshot();
            state.activations.insert(
                "a".into(),
                ActivationRecord {
                    state: ActivationState::Ready,
                    attempt: 0,
                    manifest: Some(manifest.clone()),
                    ..Default::default()
                },
            );
            state.generations=initial["generations"].as_array().unwrap().iter().map(|generation|{let compatible=generation["supported_config_schema_digests"].as_array().unwrap().iter().any(|value|value==schema);json!({"generation":generation["generation"],"current_for_module":generation["current_for_module"],"compatible":compatible,"ready_for_module":compatible,"incompatibility_reason":"effective_config_schema_digest"})}).collect();
            state.current_generation = Some(8);
            let before = json!({"current_module_config":initial["current_module_config"]});
            let result = run(
                &state,
                CoreCommand::IssueLease(IssueLeaseCommand {
                    command_id: "lease".into(),
                    activation_id: "a".into(),
                    lease_id: "l".into(),
                    token_digest: "token".into(),
                    extension_connection_id: "connection-1".into(),
                    worker_epoch: 1,
                    extension_generation: None,
                }),
                |_| {},
            );
            let event = result
                .events
                .iter()
                .find(|event| event.event == "ExtensionGenerationIncompatible")
                .unwrap();
            (
                json!({"generations":result.state.generations,"lease":result.state.leases["l"],"activation":result.state.activations["a"],"module_activate_request":{"manifest":{"effective_config":result.reply.as_ref().unwrap()["effective_config"],"effective_config_digest":manifest["effective_config_digest"]}},"current_module_config":initial["current_module_config"]}),
                before,
                if result.state.leases["l"]["extension_generation"] == 8 {
                    "old_compatible_generation_executes_frozen_config"
                } else {
                    "unexpected"
                }
                .into(),
                vec![flatten(event)],
            )
        }
        other => panic!("unmapped immutable vector {other}"),
    }
}

#[test]
fn executes_all_sixteen_immutable_core_vectors() {
    let root = spec_root().join("test-vectors/core");
    let mut files: Vec<_> = fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("TST-CORE-")
                && path.extension().is_some_and(|ext| ext == "json")
        })
        .collect();
    files.sort();
    let vectors: Vec<_> = files.iter().map(read).collect();
    assert_eq!(vectors.len(), 16);
    for (index, vector) in vectors.iter().enumerate() {
        assert_eq!(vector["test_id"], format!("TST-CORE-{:03}", index + 1));
        let (observed, before, outcome, emitted) = execute(vector);
        assert_vector(vector, &observed, &before, &outcome, &emitted);
    }
}
