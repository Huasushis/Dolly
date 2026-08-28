use std::{env, fs};

use dolly_canonical_json::canonicalize;
use dolly_core_reducer::*;
use serde_json::{Value, json};

const NOW: &str = "2026-08-13T00:00:00.000000Z";
const MANIFEST_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_DIGEST: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn digest(value: &Value) -> String {
    canonicalize(value).unwrap().1.to_canonical_string()
}

fn input() -> EnvironmentInput {
    EnvironmentInput {
        now: NOW.into(),
        graph_revision: Some(1),
        descriptor_revision: Some(1),
        ..Default::default()
    }
}

fn run(
    records: &mut Vec<Value>,
    state: &mut CoreSnapshot,
    label: &str,
    command: CoreCommand,
    input: EnvironmentInput,
) {
    let transition = reduce(state, &command, &input);
    *state = transition.state.clone();
    let mut record = json!({
        "label": label,
        "outcome": transition.outcome,
        "state_hash": transition.state_hash,
        "projection": transition.projection,
        "events": transition.events,
    });
    if let Some(reply) = transition.reply {
        record["reply"] = reply;
    }
    if let Some(error) = transition.error {
        record["error"] = serde_json::to_value(error).unwrap();
    }
    records.push(record);
}

fn main() {
    let mut state = empty_core_snapshot();
    state.subscriptions.insert(
        "worker".into(),
        SubscriptionRecord {
            cursor: 1,
            paused: None,
        },
    );
    let mut records = vec![json!({
        "label": "seed",
        "outcome": "seeded",
        "state_hash": hash_core_state(&state).unwrap(),
        "projection": project_core_state(&state),
        "events": [],
    })];

    let config = json!({"streaming": "strict", "endpoint": "local"});
    run(
        &mut records,
        &mut state,
        "install_config",
        CoreCommand::InstallConfig(InstallConfigCommand {
            command_id: "config-1".into(),
            revision: 1,
            digest: digest(&config),
            effective_config: config,
        }),
        input(),
    );

    let graph = json!({"modules": ["worker"], "edges": []});
    run(
        &mut records,
        &mut state,
        "install_graph",
        CoreCommand::InstallGraph(InstallGraphCommand {
            command_id: "graph-1".into(),
            revision: 1,
            digest: digest(&graph),
            graph,
        }),
        input(),
    );

    run(
        &mut records,
        &mut state,
        "ingress",
        CoreCommand::Ingress(IngressCommand {
            command_id: "ingress-1".into(),
            runtime_source: "host".into(),
            ingress_key: "message-1".into(),
            operation_digest:
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into(),
            block_id: "input-1".into(),
            block: json!({"kind": "text", "text": "hello"}),
            pages: vec!["worker".into(), "audit".into(), "worker".into()],
        }),
        input(),
    );

    run(
        &mut records,
        &mut state,
        "ingress_replay",
        CoreCommand::Ingress(IngressCommand {
            command_id: "ingress-replay".into(),
            runtime_source: "host".into(),
            ingress_key: "message-1".into(),
            operation_digest:
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into(),
            block_id: "ignored-on-replay".into(),
            block: json!({"kind": "text", "text": "ignored"}),
            pages: vec!["ignored".into()],
        }),
        input(),
    );

    let manifest = json!({
        "manifest_digest": MANIFEST_DIGEST,
        "reason": "input",
        "frozen_replay_contract": {"mode": "never_auto_retry", "evidence": "none", "ledger": null},
    });
    run(
        &mut records,
        &mut state,
        "build_manifest",
        CoreCommand::BuildManifest(BuildManifestCommand {
            command_id: "manifest-1".into(),
            activation_id: "activation-1".into(),
            manifest,
            expected_graph_revision: Some(1),
            expected_descriptor_revision: Some(1),
        }),
        input(),
    );

    run(
        &mut records,
        &mut state,
        "issue_lease",
        CoreCommand::IssueLease(IssueLeaseCommand {
            command_id: "lease-1".into(),
            activation_id: "activation-1".into(),
            lease_id: "lease-1".into(),
            token_digest: TOKEN_DIGEST.into(),
            extension_connection_id: "connection-1".into(),
            worker_epoch: 1,
            request_id: None,
            worker_epoch_id: None,
            extension_generation: None,
        }),
        input(),
    );

    run(
        &mut records,
        &mut state,
        "dispatch_lease",
        CoreCommand::DispatchLease(DispatchLeaseCommand {
            command_id: "dispatch-1".into(),
            activation_id: "activation-1".into(),
            lease_id: "lease-1".into(),
            dispatch_state: DispatchState::Started,
            request_id: None,
            extension_connection_id: None,
            frame_digest: None,
        }),
        input(),
    );

    let result = json!({
        "expected_cursors": {"worker": 1},
        "outputs": [{
            "block_id": "output-1",
            "block": {"kind": "text", "text": "done"},
            "deliveries": [{"block_id": "output-1", "page_id": "out"}],
        }],
        "admitted_pages": {"out": [{"page_seq": 1, "entries": [{"block_id": "output-1"}]}]},
        "projected_admission_entries": 1,
        "page_limit": 4,
    });
    let result_digest = digest(&result);
    let mut result_input = input();
    result_input.host_result_verification = Some(HostResultVerification {
        verified: true,
        activation_id: "activation-1".into(),
        lease_id: "lease-1".into(),
        token_digest: TOKEN_DIGEST.into(),
        attempt: 1,
        extension_connection_id: "connection-1".into(),
        worker_epoch: 1,
        extension_generation: None,
        manifest_digest: Some(MANIFEST_DIGEST.into()),
        result_digest: result_digest.clone(),
        payload_valid: true,
    });
    run(
        &mut records,
        &mut state,
        "receive_result",
        CoreCommand::ReceiveResult(ReceiveResultCommand {
            command_id: "result-1".into(),
            activation_id: "activation-1".into(),
            lease_id: "lease-1".into(),
            result_digest,
            status: ReceiveResultStatus::Success,
            result: Some(result),
        }),
        result_input,
    );

    run(
        &mut records,
        &mut state,
        "apply_result",
        CoreCommand::ApplyResult(ApplyResultCommand {
            command_id: "apply-1".into(),
            activation_id: "activation-1".into(),
        }),
        input(),
    );

    let bytes = canonicalize(&Value::Array(records)).unwrap().0.into_vec();
    if let Some(path) = env::args_os().nth(1) {
        fs::write(path, [&bytes[..], b"\n"].concat()).unwrap();
    } else {
        println!("{}", String::from_utf8(bytes).unwrap());
    }
}
