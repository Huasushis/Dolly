use std::collections::BTreeMap;

use dolly_canonical_json::canonicalize;
use dolly_core_reducer::*;
use serde_json::{Value, json};

const A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FENCE: &str = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
fn digest(value: &Value) -> String {
    canonicalize(value).unwrap().1.to_canonical_string()
}
fn input() -> EnvironmentInput {
    EnvironmentInput {
        now: "2026-01-01T00:00:00Z".into(),
        retry_jitter: Some(17),
        graph_revision: Some(1),
        descriptor_revision: Some(1),
        host_fence_verification: Some(HostFenceVerification {
            verified: true,
            activation_id: "a".into(),
            source_attempt: 1,
            execution_slot_empty: true,
            proof_digest: FENCE.into(),
        }),
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
fn leased(state: ActivationState, result: Option<&str>) -> CoreSnapshot {
    let mut snapshot = empty_core_snapshot();
    snapshot.activations.insert(
        "a".into(),
        ActivationRecord {
            state,
            attempt: 1,
            result_digest: result.map(str::to_string),
            authoritative_disposition: result.map(|_| state),
            ..Default::default()
        },
    );
    snapshot.leases.insert("l".into(),json!({"activation_id":"a","token_digest":"token-digest","extension_connection_id":"connection-1","worker_epoch":1,"attempt":1,"dispatch_state":if state==ActivationState::Leased{"prepared"}else{"started"}}));
    snapshot
}
fn result_proof(result_digest: &str) -> HostResultVerification {
    HostResultVerification {
        verified: true,
        payload_valid: true,
        activation_id: "a".into(),
        lease_id: "l".into(),
        token_digest: "token-digest".into(),
        attempt: 1,
        extension_connection_id: "connection-1".into(),
        worker_epoch: 1,
        extension_generation: None,
        manifest_digest: None,
        result_digest: result_digest.into(),
    }
}
fn staged(expected: BTreeMap<String, i64>, outputs: Vec<Value>) -> CoreSnapshot {
    let mut state = empty_core_snapshot();
    state.activations.insert(
        "a".into(),
        ActivationRecord {
            state: ActivationState::ResultStaged,
            attempt: 1,
            result_digest: Some(A.into()),
            authoritative_disposition: Some(ActivationState::ResultStaged),
            staged_result: Some(StagedResult {
                expected_cursors: expected,
                outputs,
                admitted_pages: BTreeMap::new(),
                projected_admission_entries: 0,
                page_limit: None,
                validation: None,
            }),
            ..Default::default()
        },
    );
    state
}

#[test]
fn ingress_replay_is_exact_and_conflict_is_not_applied() {
    let command = CoreCommand::Ingress(IngressCommand {
        command_id: "first".into(),
        runtime_source: "channel".into(),
        ingress_key: "m1".into(),
        operation_digest: A.into(),
        block_id: "block".into(),
        block: json!({"kind":"text"}),
        pages: vec!["b".into(), "a".into(), "b".into()],
    });
    let first = reduce(&empty_core_snapshot(), &command, &input());
    let replay = reduce(
        &first.state,
        &CoreCommand::Ingress(IngressCommand {
            command_id: "replay".into(),
            runtime_source: "channel".into(),
            ingress_key: "m1".into(),
            operation_digest: A.into(),
            block_id: "ignored".into(),
            block: json!({}),
            pages: vec![],
        }),
        &input(),
    );
    assert_eq!(replay.state, first.state);
    assert_eq!(replay.events.len(), 0);
    assert_eq!(first.state.deliveries.len(), 2);
    let conflict = reduce(
        &first.state,
        &CoreCommand::Ingress(IngressCommand {
            command_id: "conflict".into(),
            runtime_source: "channel".into(),
            ingress_key: "m1".into(),
            operation_digest: B.into(),
            block_id: "other".into(),
            block: json!({}),
            pages: vec![],
        }),
        &input(),
    );
    assert_eq!(conflict.error.unwrap().code, "STORAGE_IDEMPOTENCY_CONFLICT");
    assert_eq!(conflict.state, first.state);
}

#[test]
fn host_result_binding_preserves_equal_and_conflicting_committed_results() {
    let mut state = leased(ActivationState::Committed, Some(A));
    state.outputs.push(json!({"durable":true}));
    let command = |digest: &str| {
        CoreCommand::ReceiveResult(ReceiveResultCommand {
            command_id: "result".into(),
            activation_id: "a".into(),
            lease_id: "l".into(),
            result_digest: digest.into(),
            status: ReceiveResultStatus::Success,
            result: None,
        })
    };
    let mut equal_input = input();
    equal_input.host_result_verification = Some(result_proof(A));
    let equal = reduce(&state, &command(A), &equal_input);
    assert_eq!(equal.state, state);
    assert!(equal.events.is_empty());
    assert_eq!(equal.reply.unwrap()["disposition"], "committed");
    let mut conflict_input = input();
    conflict_input.host_result_verification = Some(result_proof(B));
    let conflict = reduce(&state, &command(B), &conflict_input);
    assert_eq!(conflict.error.unwrap().code, "ACTIVATION_RESULT_CONFLICT");
    assert_eq!(
        conflict.state.activations["a"].state,
        ActivationState::Committed
    );
    assert_eq!(
        conflict.state.activations["a"].result_digest.as_deref(),
        Some(A)
    );
    assert_eq!(conflict.state.outputs, vec![json!({"durable": true})]);
    let mut forged = input();
    forged.host_result_verification = Some(HostResultVerification {
        token_digest: "wrong".into(),
        ..result_proof(A)
    });
    assert_eq!(
        reduce(
            &leased(ActivationState::Dispatched, None),
            &command(A),
            &forged
        )
        .error
        .unwrap()
        .code,
        "ACTIVATION_FENCE_INVALID"
    );
}

#[test]
fn staged_application_is_atomic_and_cursor_conflict_commits_only_safety_stop() {
    let payload = json!({"expected_cursors":{"s":2},"outputs":[{"block_id":"out","block":{"kind":"text"}}],"admitted_pages":{"p":[{"page_seq":3,"entries":[{}]}]},"projected_admission_entries":1,"page_limit":4});
    let result_digest = digest(&payload);
    let mut state = leased(ActivationState::Dispatched, None);
    state.subscriptions.insert(
        "s".into(),
        SubscriptionRecord {
            cursor: 2,
            paused: None,
        },
    );
    let mut authority = input();
    authority.host_result_verification = Some(result_proof(&result_digest));
    let received = reduce(
        &state,
        &CoreCommand::ReceiveResult(ReceiveResultCommand {
            command_id: "receive".into(),
            activation_id: "a".into(),
            lease_id: "l".into(),
            result_digest: result_digest.clone(),
            status: ReceiveResultStatus::Success,
            result: Some(payload),
        }),
        &authority,
    );
    let applied = reduce(
        &received.state,
        &CoreCommand::ApplyResult(ApplyResultCommand {
            command_id: "apply".into(),
            activation_id: "a".into(),
        }),
        &input(),
    );
    assert_eq!(
        applied.state.activations["a"].state,
        ActivationState::Committed
    );
    assert_eq!(applied.state.subscriptions["s"].cursor, 3);
    assert_eq!(applied.state.next_page_seq, 4);
    assert_eq!(applied.state.blocks["out"], json!({"kind":"text"}));
    let mut conflict = staged(
        BTreeMap::from([("s".into(), 7)]),
        vec![json!({"must_not_commit":true})],
    );
    conflict.subscriptions.insert(
        "s".into(),
        SubscriptionRecord {
            cursor: 8,
            paused: None,
        },
    );
    let stopped = reduce(
        &conflict,
        &CoreCommand::ApplyResult(ApplyResultCommand {
            command_id: "conflict".into(),
            activation_id: "a".into(),
        }),
        &input(),
    );
    assert_eq!(stopped.outcome, TransitionOutcome::RolledBackWithSafetyStop);
    assert_eq!(stopped.error.unwrap().code, "ACTIVATION_CURSOR_CONFLICT");
    assert_eq!(stopped.state.mode, InstanceMode::RecoveryRequired);
    assert!(stopped.state.outputs.is_empty());
    assert_eq!(
        stopped.state.activations["a"].state,
        ActivationState::ResultStaged
    );
}

#[test]
fn safe_retry_authorization_is_bound_and_consumed_once() {
    let state = leased(ActivationState::Leased, None);
    let begun = reduce(
        &state,
        &CoreCommand::BeginFence(BeginFenceCommand {
            command_id: "begin".into(),
            activation_id: "a".into(),
        }),
        &input(),
    );
    let completed = reduce(
        &begun.state,
        &CoreCommand::FenceComplete(FenceCompleteCommand {
            command_id: "complete".into(),
            activation_id: "a".into(),
            retry_delay: 17,
        }),
        &input(),
    );
    assert_eq!(
        completed.state.activations["a"].state,
        ActivationState::RetryWait
    );
    assert_eq!(
        completed.state.activations["a"]
            .next_attempt_authorization
            .as_ref()
            .unwrap()["evidence_digest"],
        FENCE
    );
    let issued = reduce(
        &completed.state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "lease".into(),
            activation_id: "a".into(),
            lease_id: "l2".into(),
            token_digest: "token2".into(),
            extension_connection_id: "connection-2".into(),
            worker_epoch: 2,
            extension_generation: None,
        }),
        &input(),
    );
    assert_eq!(issued.state.activations["a"].attempt, 2);
    assert!(
        issued.state.activations["a"]
            .next_attempt_authorization
            .is_none()
    );
    let repeat = reduce(
        &issued.state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "again".into(),
            activation_id: "a".into(),
            lease_id: "l3".into(),
            token_digest: "token3".into(),
            extension_connection_id: "connection-3".into(),
            worker_epoch: 3,
            extension_generation: None,
        }),
        &input(),
    );
    assert_eq!(repeat.error.unwrap().code, "ACTIVATION_NOT_LEASABLE");
}

#[test]
fn started_never_auto_retry_and_unverified_replay_evidence_fail_closed() {
    let mut state = leased(ActivationState::Dispatched, None);
    state.activations.get_mut("a").unwrap().manifest =
        Some(json!({"frozen_replay_contract":{"mode":"never_auto_retry","evidence":"none"}}));
    let begun = reduce(
        &state,
        &CoreCommand::BeginFence(BeginFenceCommand {
            command_id: "begin".into(),
            activation_id: "a".into(),
        }),
        &input(),
    );
    let completed = reduce(
        &begun.state,
        &CoreCommand::FenceComplete(FenceCompleteCommand {
            command_id: "complete".into(),
            activation_id: "a".into(),
            retry_delay: 1,
        }),
        &input(),
    );
    assert_eq!(
        completed.state.activations["a"].state,
        ActivationState::Quarantined
    );
    assert_eq!(
        completed.state.quarantines["a"]["reason"],
        "ACTIVATION_REPLAY_NOT_AUTHORIZED"
    );
    let mut ledger = leased(ActivationState::Dispatched, None);
    ledger.activations.get_mut("a").unwrap().manifest = Some(
        json!({"frozen_replay_contract":{"mode":"fenced_replay","evidence":"activation_ledger"}}),
    );
    let begun = reduce(
        &ledger,
        &CoreCommand::BeginFence(BeginFenceCommand {
            command_id: "begin".into(),
            activation_id: "a".into(),
        }),
        &input(),
    );
    let mut bad = input();
    bad.host_replay_evidence = Some(HostReplayEvidence {
        verified: false,
        activation_id: "a".into(),
        source_attempt: 1,
        target_generation: None,
        observation: ReplayEvidenceObservation::Succeeded,
        record: json!({}),
        digest: digest(&json!({})),
    });
    let rejected = reduce(
        &begun.state,
        &CoreCommand::RecordReplayEvidence(RecordReplayEvidenceCommand {
            command_id: "record".into(),
            activation_id: "a".into(),
        }),
        &bad,
    );
    assert_eq!(
        rejected.error.unwrap().code,
        "ACTIVATION_REPLAY_EVIDENCE_INVALID"
    );
}

#[test]
fn recovery_requires_ordered_host_checks_and_never_regresses_page_sequence() {
    let mut state = empty_core_snapshot();
    state.mode = InstanceMode::RecoveryRequired;
    state.next_page_seq = 9;
    let recover = CoreCommand::Recover(RecoverCommand {
        command_id: "recover".into(),
        persisted_next_page_seq: 9,
    });
    let mut incomplete = input();
    incomplete
        .recovery_verification
        .as_mut()
        .unwrap()
        .ordered_checks_complete = false;
    assert_eq!(
        reduce(&state, &recover, &incomplete).error.unwrap().code,
        "RECOVERY_VERIFICATION_INCOMPLETE"
    );
    let regression = CoreCommand::Recover(RecoverCommand {
        command_id: "regress".into(),
        persisted_next_page_seq: 8,
    });
    assert_eq!(
        reduce(&state, &regression, &input()).error.unwrap().code,
        "PAGE_SEQUENCE_REGRESSION"
    );
    let mut invalid = input();
    invalid
        .recovery_verification
        .as_mut()
        .unwrap()
        .persisted_values_valid = false;
    let stopped = reduce(&state, &recover, &invalid);
    assert_eq!(stopped.state.mode, InstanceMode::RecoveryRequired);
    assert_eq!(
        reduce(&stopped.state, &recover, &input()).state.mode,
        InstanceMode::Running
    );
}

#[test]
fn canonical_integrity_digests_are_required() {
    let config = json!({"mode":"strict"});
    let bad = CoreCommand::InstallConfig(InstallConfigCommand {
        command_id: "bad".into(),
        revision: 1,
        effective_config: config.clone(),
        digest: "d".into(),
    });
    assert_eq!(
        reduce(&empty_core_snapshot(), &bad, &input())
            .error
            .unwrap()
            .code,
        "CONFIG_DIGEST_MISMATCH"
    );
    let good = CoreCommand::InstallConfig(InstallConfigCommand {
        command_id: "good".into(),
        revision: 1,
        effective_config: config.clone(),
        digest: digest(&config),
    });
    assert_eq!(
        reduce(&empty_core_snapshot(), &good, &input()).state.config["revision"],
        1
    )
}

#[test]
fn all_twenty_one_wire_variants_deserialize_and_reach_the_reducer() {
    let values = vec![
        json!({"type":"InstallConfig","command_id":"1","revision":1,"effective_config":{},"digest":digest(&json!({}))}),
        json!({"type":"InstallGraph","command_id":"2","revision":1,"graph":{},"digest":digest(&json!({}))}),
        json!({"type":"Ingress","command_id":"3","runtime_source":"r","ingress_key":"k","operation_digest":A,"block_id":"b","block":{},"pages":[]}),
        json!({"type":"RuntimeEvent","command_id":"4","runtime_source":"r","event_key":"e","operation_digest":A,"block_id":"b","block":{},"pages":[]}),
        json!({"type":"GrantStorageWriter","command_id":"5","owner":"w"}),
        json!({"type":"ReleaseStorageWriter","command_id":"6","owner":"w"}),
        json!({"type":"BuildManifest","command_id":"7","activation_id":"a","manifest":{}}),
        json!({"type":"IssueLease","command_id":"8","activation_id":"a","lease_id":"l","token_digest":"t","extension_connection_id":"connection-1","worker_epoch":1}),
        json!({"type":"DispatchLease","command_id":"9","activation_id":"a","lease_id":"l","dispatch_state":"started"}),
        json!({"type":"ReceiveResult","command_id":"10","activation_id":"a","lease_id":"l","result_digest":A,"status":"success"}),
        json!({"type":"BeginFence","command_id":"11","activation_id":"a"}),
        json!({"type":"RecordReplayEvidence","command_id":"12","activation_id":"a"}),
        json!({"type":"FenceComplete","command_id":"13","activation_id":"a","retry_delay":1}),
        json!({"type":"ApplyResult","command_id":"14","activation_id":"a"}),
        json!({"type":"CancelActivation","command_id":"15","activation_id":"a","reason":"x"}),
        json!({"type":"ResolveQuarantine","command_id":"16","activation_id":"a","resolution":"cancel"}),
        json!({"type":"CompleteQuarantineFence","command_id":"17","activation_id":"a"}),
        json!({"type":"DeadLetterRange","command_id":"18","subscription_id":"s","start":1,"end_exclusive":2,"reason":"x"}),
        json!({"type":"SkipRange","command_id":"19","subscription_id":"s","start":1,"end_exclusive":2}),
        json!({"type":"LossyEvict","command_id":"20","page_id":"p","start":1,"end_exclusive":2,"reason":"x"}),
        json!({"type":"Recover","command_id":"21","persisted_next_page_seq":2}),
    ];
    assert_eq!(values.len(), 21);
    for value in values {
        let command: CoreCommand = serde_json::from_value(value).unwrap();
        let transition = reduce(&empty_core_snapshot(), &command, &input());
        assert!(transition.state_hash.starts_with("sha256:"));
    }
}

#[test]
fn every_normative_crash_label_observes_exact_prior_or_complete_state() {
    let labels: Vec<String> = (1..=15).map(|index| format!("CP-{index:02}")).collect();
    for (index, label) in labels.iter().enumerate() {
        let state = empty_core_snapshot();
        let command = CoreCommand::RuntimeEvent(RuntimeEventCommand {
            command_id: label.clone(),
            runtime_source: "crash".into(),
            event_key: label.clone(),
            operation_digest: A.into(),
            block_id: label.clone(),
            block: json!({"label":label}),
            pages: vec!["p".into()],
        });
        let observation = if matches!(index + 1, 3 | 4 | 5 | 6 | 7 | 9 | 10 | 11) {
            StorageObservation::AfterCommit
        } else {
            StorageObservation::BeforeCommit
        };
        let mut tape = input();
        tape.crash_point = Some(label.clone());
        tape.storage_observation = Some(observation);
        let result = reduce(&state, &command, &tape);
        if observation == StorageObservation::BeforeCommit {
            assert_eq!(
                result.state_hash,
                hash_core_state(&state).unwrap(),
                "{label}"
            );
            assert!(result.events.is_empty(), "{label}");
        } else {
            assert_eq!(result.outcome, TransitionOutcome::Committed, "{label}");
            assert_ne!(
                result.state_hash,
                hash_core_state(&state).unwrap(),
                "{label}"
            );
        }
    }
}

#[test]
fn generated_fanout_holds_idempotency_and_crash_rollback() {
    for seed in 1..=128 {
        let pages: Vec<String> = (0..1 + seed % 9)
            .map(|index| format!("p{}", (seed * 17 + index * 13) % 7))
            .collect();
        let command = CoreCommand::Ingress(IngressCommand {
            command_id: format!("i{seed}"),
            runtime_source: format!("r{}", seed % 3),
            ingress_key: format!("k{seed}"),
            operation_digest: A.into(),
            block_id: format!("b{seed}"),
            block: json!({"seed":seed}),
            pages: pages.clone(),
        });
        let first = reduce(&empty_core_snapshot(), &command, &input());
        let replay = reduce(&first.state, &command, &input());
        assert_eq!(replay.state_hash, first.state_hash);
        assert_eq!(
            first.state.deliveries.len(),
            pages
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
        );
        let mut crash = input();
        crash.storage_observation = Some(StorageObservation::BeforeCommit);
        let rolled = reduce(&empty_core_snapshot(), &command, &crash);
        assert_eq!(
            rolled.state_hash,
            hash_core_state(&empty_core_snapshot()).unwrap()
        );
    }
}

#[test]
fn current_lease_controls_each_retry_attempt() {
    let mut state = empty_core_snapshot();
    state.activations.insert(
        "a".into(),
        ActivationRecord {
            state: ActivationState::Ready,
            ..Default::default()
        },
    );
    let first = reduce(
        &state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "l1".into(),
            activation_id: "a".into(),
            lease_id: "l1".into(),
            token_digest: "t1".into(),
            extension_connection_id: "connection-1".into(),
            worker_epoch: 1,
            extension_generation: None,
        }),
        &input(),
    );
    let first_fence = reduce(
        &first.state,
        &CoreCommand::BeginFence(BeginFenceCommand {
            command_id: "f1".into(),
            activation_id: "a".into(),
        }),
        &input(),
    );
    let first_retry = reduce(
        &first_fence.state,
        &CoreCommand::FenceComplete(FenceCompleteCommand {
            command_id: "fc1".into(),
            activation_id: "a".into(),
            retry_delay: 1,
        }),
        &input(),
    );
    let second = reduce(
        &first_retry.state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "l2".into(),
            activation_id: "a".into(),
            lease_id: "l2".into(),
            token_digest: "t2".into(),
            extension_connection_id: "connection-2".into(),
            worker_epoch: 2,
            extension_generation: None,
        }),
        &input(),
    );
    let second_fence = reduce(
        &second.state,
        &CoreCommand::BeginFence(BeginFenceCommand {
            command_id: "f2".into(),
            activation_id: "a".into(),
        }),
        &input(),
    );
    let mut second_input = input();
    second_input
        .host_fence_verification
        .as_mut()
        .unwrap()
        .source_attempt = 2;
    let second_retry = reduce(
        &second_fence.state,
        &CoreCommand::FenceComplete(FenceCompleteCommand {
            command_id: "fc2".into(),
            activation_id: "a".into(),
            retry_delay: 2,
        }),
        &second_input,
    );
    assert_eq!(
        second_retry.state.activations["a"].state,
        ActivationState::RetryWait
    );
    assert_eq!(second_retry.state.leases["l2"]["dispatch_state"], "fenced");
}

#[test]
fn result_and_replay_authority_require_exact_execution_bindings() {
    let payload = json!({});
    let payload_digest = digest(&payload);
    let command = CoreCommand::ReceiveResult(ReceiveResultCommand {
        command_id: "receive".into(),
        activation_id: "a".into(),
        lease_id: "l".into(),
        result_digest: payload_digest.clone(),
        status: ReceiveResultStatus::Success,
        result: Some(payload),
    });
    let mut generation_proof = result_proof(&payload_digest);
    generation_proof.extension_generation = Some(8);
    let mut environment = input();
    environment.host_result_verification = Some(generation_proof);
    assert_eq!(
        reduce(
            &leased(ActivationState::Dispatched, None),
            &command,
            &environment
        )
        .error
        .unwrap()
        .code,
        "ACTIVATION_FENCE_INVALID"
    );
    let mut connection_proof = result_proof(&payload_digest);
    connection_proof.extension_connection_id = "other".into();
    environment.host_result_verification = Some(connection_proof);
    assert_eq!(
        reduce(
            &leased(ActivationState::Dispatched, None),
            &command,
            &environment
        )
        .error
        .unwrap()
        .code,
        "ACTIVATION_FENCE_INVALID"
    );

    let mut replay = leased(ActivationState::Fencing, None);
    replay
        .activations
        .get_mut("a")
        .unwrap()
        .extension_generation = Some(8);
    replay.activations.get_mut("a").unwrap().manifest = Some(json!({
        "manifest_digest":A,
        "module_id":"writer",
        "storage_scope_id":"scope-1",
        "frozen_replay_contract":{
            "mode":"fenced_replay",
            "evidence":"activation_ledger",
            "ledger":{"namespace":"effects"},
        },
    }));
    replay.leases.get_mut("l").unwrap()["extension_generation"] = json!(8);
    replay.leases.get_mut("l").unwrap()["manifest_digest"] = json!(A);
    let evidence_command = CoreCommand::RecordReplayEvidence(RecordReplayEvidenceCommand {
        command_id: "evidence".into(),
        activation_id: "a".into(),
    });
    let forged = json!({
        "activation_id":"a",
        "source_attempt":1,
        "manifest_digest":A,
        "module_id":"other",
        "storage_scope_id":"scope-1",
        "target_extension_generation":8,
        "ledger":{"namespace":"effects"},
        "ledger_state":"complete",
    });
    environment.host_replay_evidence = Some(HostReplayEvidence {
        verified: true,
        activation_id: "a".into(),
        source_attempt: 1,
        target_generation: Some(8),
        observation: ReplayEvidenceObservation::Succeeded,
        digest: digest(&forged),
        record: forged,
    });
    assert_eq!(
        reduce(&replay, &evidence_command, &environment)
            .error
            .unwrap()
            .code,
        "ACTIVATION_REPLAY_EVIDENCE_INVALID"
    );
    environment.host_replay_evidence = Some(HostReplayEvidence {
        verified: true,
        activation_id: "a".into(),
        source_attempt: 1,
        target_generation: Some(8),
        observation: ReplayEvidenceObservation::Unknown,
        digest: digest(&json!(42)),
        record: json!(42),
    });
    assert_eq!(
        reduce(&replay, &evidence_command, &environment)
            .error
            .unwrap()
            .code,
        "ACTIVATION_REPLAY_EVIDENCE_INVALID"
    );
}

#[test]
fn invalid_dispositions_recovery_and_quarantine_resolution_preserve_state() {
    for command in [
        CoreCommand::DeadLetterRange(DeadLetterRangeCommand {
            command_id: "dead".into(),
            subscription_id: "s".into(),
            start: 5,
            end_exclusive: 3,
            reason: "invalid".into(),
        }),
        CoreCommand::SkipRange(SkipRangeCommand {
            command_id: "skip".into(),
            subscription_id: "s".into(),
            start: 5,
            end_exclusive: 3,
        }),
    ] {
        let mut state = empty_core_snapshot();
        state.next_page_seq = 10;
        state.subscriptions.insert(
            "s".into(),
            SubscriptionRecord {
                cursor: 5,
                paused: None,
            },
        );
        let result = reduce(&state, &command, &input());
        assert_eq!(
            result.error.unwrap().code,
            "SUBSCRIPTION_DISPOSITION_CONFLICT"
        );
        assert_eq!(result.state.subscriptions["s"].cursor, 5);
    }

    let mut recovering = empty_core_snapshot();
    recovering.mode = InstanceMode::RecoveryRequired;
    recovering.next_page_seq = 7;
    recovering.volatile_lossy_entries = vec![json!({"page_id":"lossy","page_seq":7})];
    let mut failed_verification = input();
    failed_verification
        .recovery_verification
        .as_mut()
        .unwrap()
        .invariants_valid = false;
    let failed = reduce(
        &recovering,
        &CoreCommand::Recover(RecoverCommand {
            command_id: "recover".into(),
            persisted_next_page_seq: 12,
        }),
        &failed_verification,
    );
    assert_eq!(failed.state.next_page_seq, 7);
    assert_eq!(
        failed.state.volatile_lossy_entries,
        recovering.volatile_lossy_entries
    );
    assert_eq!(failed.state.mode, InstanceMode::RecoveryRequired);

    let mut committed = leased(ActivationState::Committed, Some(A));
    committed.outputs = vec![json!({"durable":true})];
    committed
        .quarantines
        .insert("a".into(), json!({"fence_complete":true}));
    let retried = reduce(
        &committed,
        &CoreCommand::ResolveQuarantine(ResolveQuarantineCommand {
            command_id: "resolve".into(),
            activation_id: "a".into(),
            resolution: ResolveQuarantineResolution::Retry,
            retry_delay: None,
        }),
        &input(),
    );
    assert_eq!(
        retried.error.unwrap().code,
        "ACTIVATION_COMMITTED_IMMUTABLE"
    );
    assert_eq!(retried.state.outputs, committed.outputs);
}

#[test]
fn manifest_identity_is_immutable_and_stale_builds_emit_observed_retry() {
    let command = |command_id: &str, reason: &str| {
        CoreCommand::BuildManifest(BuildManifestCommand {
            command_id: command_id.into(),
            activation_id: "a".into(),
            manifest: json!({"reason":reason}),
            expected_graph_revision: None,
            expected_descriptor_revision: None,
        })
    };
    let first = reduce(&empty_core_snapshot(), &command("first", "input"), &input());
    let replay = reduce(&first.state, &command("replay", "input"), &input());
    assert_eq!(replay.state_hash, first.state_hash);
    assert!(replay.events.is_empty());
    let conflict = reduce(&first.state, &command("conflict", "timer"), &input());
    assert_eq!(conflict.error.unwrap().code, "STORAGE_IDEMPOTENCY_CONFLICT");
    assert_eq!(conflict.state.manifests["a"]["reason"], "input");

    let stale = CoreCommand::BuildManifest(BuildManifestCommand {
        command_id: "stale".into(),
        activation_id: "stale".into(),
        manifest: json!({}),
        expected_graph_revision: Some(1),
        expected_descriptor_revision: Some(1),
    });
    let mut changed = input();
    changed.graph_revision = Some(2);
    let result = reduce(&empty_core_snapshot(), &stale, &changed);
    assert_eq!(result.error.unwrap().code, "MANIFEST_BUILD_CAS_RETRY");
    assert_eq!(result.events[0].event, "ManifestBuildCasRetry");
    assert_eq!(
        result.events[0].details.as_ref().unwrap()["reason"],
        "graph_or_descriptor_changed"
    );
    assert_eq!(
        result.state_hash,
        hash_core_state(&empty_core_snapshot()).unwrap()
    );
}

#[test]
fn lease_ids_are_immutable_across_activations_and_replay_exactly() {
    let mut state = empty_core_snapshot();
    for activation_id in ["a", "b"] {
        state.activations.insert(
            activation_id.into(),
            ActivationRecord {
                state: ActivationState::Ready,
                ..Default::default()
            },
        );
    }
    let command = CoreCommand::IssueLease(IssueLeaseCommand {
        command_id: "lease-a".into(),
        activation_id: "a".into(),
        lease_id: "lease-1".into(),
        token_digest: "token-a".into(),
        extension_connection_id: "connection-a".into(),
        worker_epoch: 1,
        extension_generation: None,
    });
    let first = reduce(&state, &command, &input());
    let replay = reduce(&first.state, &command, &input());
    assert_eq!(replay.state_hash, first.state_hash);
    assert!(replay.events.is_empty());
    let collision = reduce(
        &first.state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "lease-b".into(),
            activation_id: "b".into(),
            lease_id: "lease-1".into(),
            token_digest: "token-b".into(),
            extension_connection_id: "connection-b".into(),
            worker_epoch: 2,
            extension_generation: None,
        }),
        &input(),
    );
    assert_eq!(
        collision.error.unwrap().code,
        "STORAGE_IDEMPOTENCY_CONFLICT"
    );
    assert_eq!(collision.state.leases["lease-1"]["activation_id"], "a");
    assert_eq!(
        collision.state.activations["b"].state,
        ActivationState::Ready
    );
}

#[test]
fn unsafe_page_sequences_and_malformed_snapshots_fail_closed() {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    for page_seq in [MAX_SAFE_INTEGER, MAX_SAFE_INTEGER + 1, i64::MAX] {
        let payload = json!({
            "expected_cursors":{},
            "outputs":[],
            "admitted_pages":{"out":[{"page_seq":page_seq,"entries":[]}]},
            "projected_admission_entries":0,
        });
        let payload_digest = digest(&payload);
        let command = CoreCommand::ReceiveResult(ReceiveResultCommand {
            command_id: format!("receive-{page_seq}"),
            activation_id: "a".into(),
            lease_id: "l".into(),
            result_digest: payload_digest.clone(),
            status: ReceiveResultStatus::Success,
            result: Some(payload),
        });
        let mut environment = input();
        environment.host_result_verification = Some(result_proof(&payload_digest));
        assert_eq!(
            reduce(
                &leased(ActivationState::Dispatched, None),
                &command,
                &environment
            )
            .error
            .unwrap()
            .code,
            "ACTIVATION_INVALID_RESULT"
        );
    }

    let mut malformed = empty_core_snapshot();
    malformed.blocks.insert(
        "negative-zero".into(),
        serde_json::from_str::<Value>("-0.0").unwrap(),
    );
    assert!(hash_core_state(&malformed).is_err());
    let stopped = reduce(
        &malformed,
        &CoreCommand::Ingress(IngressCommand {
            command_id: "ignored".into(),
            runtime_source: "host".into(),
            ingress_key: "ignored".into(),
            operation_digest: A.into(),
            block_id: "ignored".into(),
            block: json!({}),
            pages: Vec::new(),
        }),
        &input(),
    );
    assert_eq!(stopped.outcome, TransitionOutcome::RolledBackWithSafetyStop);
    assert_eq!(stopped.state.mode, InstanceMode::RecoveryRequired);
    assert_eq!(
        stopped.error.unwrap().code,
        "CORE_STATE_CANONICAL_JSON_INVALID"
    );

    let mut malformed_quarantine = leased(ActivationState::Quarantined, None);
    malformed_quarantine
        .quarantines
        .insert("a".into(), Value::Null);
    let result = reduce(
        &malformed_quarantine,
        &CoreCommand::CompleteQuarantineFence(CompleteQuarantineFenceCommand {
            command_id: "complete".into(),
            activation_id: "a".into(),
        }),
        &input(),
    );
    assert_eq!(result.error.unwrap().code, "QUARANTINE_STATE_INVALID");
}

#[test]
fn durable_counter_exhaustion_fails_closed_without_panicking() {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    let ingress = CoreCommand::Ingress(IngressCommand {
        command_id: "counter-check".into(),
        runtime_source: "host".into(),
        ingress_key: "counter-check".into(),
        operation_digest: A.into(),
        block_id: "counter-check".into(),
        block: json!({}),
        pages: Vec::new(),
    });

    for malformed in [
        {
            let mut state = empty_core_snapshot();
            state.next_commit_seq = i64::MAX;
            state
        },
        {
            let mut state = empty_core_snapshot();
            state.activations.insert(
                "a".into(),
                ActivationRecord {
                    state: ActivationState::Ready,
                    attempt: i64::MAX,
                    ..Default::default()
                },
            );
            state
        },
    ] {
        let stopped = reduce(&malformed, &ingress, &input());
        assert_eq!(stopped.outcome, TransitionOutcome::RolledBackWithSafetyStop);
        assert_eq!(stopped.state.mode, InstanceMode::RecoveryRequired);
        assert_eq!(stopped.error.unwrap().code, "CORE_STATE_COUNTER_INVALID");
    }

    let mut exhausted_commits = empty_core_snapshot();
    exhausted_commits.next_commit_seq = MAX_SAFE_INTEGER;
    let result = reduce(&exhausted_commits, &ingress, &input());
    assert_eq!(result.error.unwrap().code, "COMMIT_SEQUENCE_EXHAUSTED");
    assert_eq!(result.state, exhausted_commits);

    let mut exhausted_attempt = empty_core_snapshot();
    exhausted_attempt.activations.insert(
        "a".into(),
        ActivationRecord {
            state: ActivationState::Ready,
            attempt: MAX_SAFE_INTEGER,
            ..Default::default()
        },
    );
    let issue = CoreCommand::IssueLease(IssueLeaseCommand {
        command_id: "lease".into(),
        activation_id: "a".into(),
        lease_id: "lease".into(),
        token_digest: "token".into(),
        extension_connection_id: "connection".into(),
        worker_epoch: 1,
        extension_generation: None,
    });
    let result = reduce(&exhausted_attempt, &issue, &input());
    assert_eq!(result.error.unwrap().code, "ATTEMPT_SEQUENCE_EXHAUSTED");
    assert_eq!(result.state, exhausted_attempt);

    let mut exhausted_generation_events = empty_core_snapshot();
    exhausted_generation_events.next_commit_seq = MAX_SAFE_INTEGER - 2;
    exhausted_generation_events.activations.insert(
        "a".into(),
        ActivationRecord {
            state: ActivationState::Ready,
            ..Default::default()
        },
    );
    exhausted_generation_events.generations = vec![
        json!({"generation":1,"compatible":false}),
        json!({"generation":2,"compatible":false}),
    ];
    let result = reduce(&exhausted_generation_events, &issue, &input());
    assert_eq!(result.error.unwrap().code, "COMMIT_SEQUENCE_EXHAUSTED");
    assert_eq!(result.state, exhausted_generation_events);
}

#[test]
fn recovery_rejects_unsafe_persisted_page_sequence() {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    let mut state = empty_core_snapshot();
    state.mode = InstanceMode::RecoveryRequired;
    state.next_page_seq = 7;
    for persisted_next_page_seq in [MAX_SAFE_INTEGER + 1, i64::MAX] {
        let result = reduce(
            &state,
            &CoreCommand::Recover(RecoverCommand {
                command_id: format!("recover-{persisted_next_page_seq}"),
                persisted_next_page_seq,
            }),
            &input(),
        );
        assert_eq!(result.error.unwrap().code, "PAGE_SEQUENCE_INVALID");
        assert_eq!(result.state, state);
    }
}

#[test]
fn issue_lease_idempotency_replay_omitting_generation_conflicts() {
    let mut state = empty_core_snapshot();
    state.activations.insert(
        "a".into(),
        ActivationRecord {
            state: ActivationState::Ready,
            attempt: 0,
            ..Default::default()
        },
    );
    state
        .generations
        .push(json!({"generation": 8, "compatible": true}));
    let original = reduce(
        &state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "cmd-1".into(),
            activation_id: "a".into(),
            lease_id: "lease-1".into(),
            token_digest: A.into(),
            extension_connection_id: "conn-1".into(),
            worker_epoch: 1,
            extension_generation: Some(8),
        }),
        &input(),
    );
    assert_eq!(original.outcome, TransitionOutcome::Committed);
    assert_eq!(
        original.reply.as_ref().unwrap()["extension_generation"],
        json!(8)
    );
    let replay = reduce(
        &original.state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "cmd-2".into(),
            activation_id: "a".into(),
            lease_id: "lease-1".into(),
            token_digest: A.into(),
            extension_connection_id: "conn-1".into(),
            worker_epoch: 1,
            extension_generation: None,
        }),
        &input(),
    );
    assert_eq!(replay.error.unwrap().code, "STORAGE_IDEMPOTENCY_CONFLICT");
}

#[test]
fn issue_lease_idempotency_replay_matching_generation_accepted() {
    let mut state = empty_core_snapshot();
    state.activations.insert(
        "a".into(),
        ActivationRecord {
            state: ActivationState::Ready,
            attempt: 0,
            ..Default::default()
        },
    );
    state
        .generations
        .push(json!({"generation": 8, "compatible": true}));
    let original = reduce(
        &state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "cmd-1".into(),
            activation_id: "a".into(),
            lease_id: "lease-1".into(),
            token_digest: A.into(),
            extension_connection_id: "conn-1".into(),
            worker_epoch: 1,
            extension_generation: Some(8),
        }),
        &input(),
    );
    assert_eq!(original.outcome, TransitionOutcome::Committed);
    let replay = reduce(
        &original.state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "cmd-2".into(),
            activation_id: "a".into(),
            lease_id: "lease-1".into(),
            token_digest: A.into(),
            extension_connection_id: "conn-1".into(),
            worker_epoch: 1,
            extension_generation: Some(8),
        }),
        &input(),
    );
    assert_eq!(replay.outcome, TransitionOutcome::Committed);
    assert_eq!(
        replay.reply.as_ref().unwrap()["extension_generation"],
        json!(8)
    );
}

#[test]
fn issue_lease_idempotency_replay_both_lacking_generation_accepted() {
    let mut state = empty_core_snapshot();
    state.activations.insert(
        "a".into(),
        ActivationRecord {
            state: ActivationState::Ready,
            attempt: 0,
            ..Default::default()
        },
    );
    let original = reduce(
        &state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "cmd-1".into(),
            activation_id: "a".into(),
            lease_id: "lease-2".into(),
            token_digest: A.into(),
            extension_connection_id: "conn-1".into(),
            worker_epoch: 1,
            extension_generation: None,
        }),
        &input(),
    );
    assert_eq!(original.outcome, TransitionOutcome::Committed);
    let replay = reduce(
        &original.state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "cmd-2".into(),
            activation_id: "a".into(),
            lease_id: "lease-2".into(),
            token_digest: A.into(),
            extension_connection_id: "conn-1".into(),
            worker_epoch: 1,
            extension_generation: None,
        }),
        &input(),
    );
    assert_eq!(replay.outcome, TransitionOutcome::Committed);
}

#[test]
fn issue_lease_idempotency_replay_mismatched_generation_conflicts() {
    let mut state = empty_core_snapshot();
    state.activations.insert(
        "a".into(),
        ActivationRecord {
            state: ActivationState::Ready,
            attempt: 0,
            ..Default::default()
        },
    );
    state
        .generations
        .push(json!({"generation": 8, "compatible": true}));
    state
        .generations
        .push(json!({"generation": 9, "compatible": true}));
    let original = reduce(
        &state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "cmd-1".into(),
            activation_id: "a".into(),
            lease_id: "lease-3".into(),
            token_digest: A.into(),
            extension_connection_id: "conn-1".into(),
            worker_epoch: 1,
            extension_generation: Some(8),
        }),
        &input(),
    );
    assert_eq!(original.outcome, TransitionOutcome::Committed);
    let replay = reduce(
        &original.state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "cmd-2".into(),
            activation_id: "a".into(),
            lease_id: "lease-3".into(),
            token_digest: A.into(),
            extension_connection_id: "conn-1".into(),
            worker_epoch: 1,
            extension_generation: Some(9),
        }),
        &input(),
    );
    assert_eq!(replay.error.unwrap().code, "STORAGE_IDEMPOTENCY_CONFLICT");
}

#[test]
fn issue_lease_idempotency_replay_omitting_generation_conflicts_with_present_null() {
    let mut state = empty_core_snapshot();
    state.activations.insert(
        "a".into(),
        ActivationRecord {
            state: ActivationState::Ready,
            attempt: 0,
            ..Default::default()
        },
    );
    // Simulate a corrupted/malformed stored lease with a present null extension_generation
    state.leases.insert(
        "lease-malformed".into(),
        json!({
            "activation_id": "a",
            "token_digest": A,
            "extension_connection_id": "conn-1",
            "worker_epoch": 1,
            "attempt": 1,
            "extension_generation": null
        }),
    );
    let replay = reduce(
        &state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "cmd-1".into(),
            activation_id: "a".into(),
            lease_id: "lease-malformed".into(),
            token_digest: A.into(),
            extension_connection_id: "conn-1".into(),
            worker_epoch: 1,
            extension_generation: None,
        }),
        &input(),
    );
    assert_eq!(replay.error.unwrap().code, "STORAGE_IDEMPOTENCY_CONFLICT");
}

#[test]
fn issue_lease_idempotency_replay_omitting_generation_conflicts_with_present_string() {
    let mut state = empty_core_snapshot();
    state.activations.insert(
        "a".into(),
        ActivationRecord {
            state: ActivationState::Ready,
            attempt: 0,
            ..Default::default()
        },
    );
    // Simulate a malformed stored lease with a present string extension_generation
    state.leases.insert(
        "lease-malformed-str".into(),
        json!({
            "activation_id": "a",
            "token_digest": A,
            "extension_connection_id": "conn-1",
            "worker_epoch": 1,
            "attempt": 1,
            "extension_generation": "8"
        }),
    );
    let replay = reduce(
        &state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "cmd-1".into(),
            activation_id: "a".into(),
            lease_id: "lease-malformed-str".into(),
            token_digest: A.into(),
            extension_connection_id: "conn-1".into(),
            worker_epoch: 1,
            extension_generation: None,
        }),
        &input(),
    );
    assert_eq!(replay.error.unwrap().code, "STORAGE_IDEMPOTENCY_CONFLICT");
}

#[test]
fn malformed_present_lease_generation_rejects_binding_when_proof_omits_generation() {
    let mut state = leased(ActivationState::Dispatched, None);
    state.leases.insert(
        "l".into(),
        json!({"activation_id":"a","token_digest":"token-digest","extension_connection_id":"connection-1","worker_epoch":1,"attempt":1,"dispatch_state":"started","extension_generation":"8"}),
    );
    let mut binding_input = input();
    binding_input.host_result_verification = Some(result_proof(A));
    let result = reduce(
        &state,
        &CoreCommand::ReceiveResult(ReceiveResultCommand {
            command_id: "result".into(),
            activation_id: "a".into(),
            lease_id: "l".into(),
            result_digest: A.into(),
            status: ReceiveResultStatus::Success,
            result: None,
        }),
        &binding_input,
    );
    assert_eq!(result.error.unwrap().code, "ACTIVATION_FENCE_INVALID");
}

#[test]
fn issue_lease_refuses_malformed_present_pool_generation() {
    let mut state = empty_core_snapshot();
    state.activations.insert(
        "a".into(),
        ActivationRecord {
            state: ActivationState::Ready,
            attempt: 0,
            ..Default::default()
        },
    );
    state.generations = vec![json!({"generation":"8","compatible":true})];
    let result = reduce(
        &state,
        &CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "lease-1".into(),
            activation_id: "a".into(),
            lease_id: "lease-1".into(),
            token_digest: A.into(),
            extension_connection_id: "connection-1".into(),
            worker_epoch: 1,
            extension_generation: Some(8),
        }),
        &input(),
    );
    assert_eq!(result.error.unwrap().code, "CORE_STATE_GENERATION_INVALID");
}
