//! Contract tests for behaviors the vectors do not pin directly:
//! two-stage digest conflict/replay ordering, backend-spy zero-call proof on
//! denials, stage-2 generation selection, spec §5 digest bases (independent
//! canonical fixtures, never self-referential), and fail-closed version
//! boundary.

use dolly_tool_broker::{
    AdmissionOutcome, ExistingOperation, InvokeCandidate, InvokeOutcome, ResolutionBackend,
    ResolvedToolBrokerConfig, StatusOutcome, ToolErrorCode, admit_config, evaluate_invoke,
    lookup_status, request_digest,
};
use serde_json::{Value, json};

use dolly_canonical_json::{Sha256Digest, canonicalize};

fn digest_hex(full: &str) -> Sha256Digest {
    full.parse().expect("valid sha256 digest string")
}

/// The complete `host.tool.invoke` params (identity + params, spec §5),
/// matching `tool-invoke.schema.json` so `P` is the full playback identity.
fn full_params() -> Value {
    let tool_schema_digest = canonicalize(
        &closed_registry_config()["servers"]["fs"]["tools"]["read-file"]["input_schema"],
    )
    .unwrap()
    .1
    .to_canonical_string();
    json!({
        "operation_id": "0198ab31-6c44-7e8a-b2bb-000000000345",
        "tool_transaction_id": "0198ab31-6c44-7e8a-b2bb-000000000099",
        "module_id": "module-a",
        "activation_id": "0198ab31-6c44-7e8a-b2bb-000000000101",
        "config_revision": 11,
        "lease_token": "lease-token-1",
        "tool_server_id": "fs",
        "tool_name": "read-file",
        "tool_schema_digest": tool_schema_digest,
        "arguments": {"path": "/etc/hostname"},
        "side_effect_class": "read_only",
        "idempotency_key": null,
        "confirmation_id": null,
        "deadline": "2026-08-21T00:00:00.000000Z"
    })
}

/// Independent oracle for `request_digest`: applies the spec §5 definition
/// directly (complete params minus only operation_id/deadline/lease_token)
/// using generic JSON + `canonicalize`, never calling the crate helper.
fn expected_request_digest(params: &Value) -> Sha256Digest {
    let mut p = params.as_object().expect("params is an object").clone();
    p.remove("operation_id");
    p.remove("deadline");
    p.remove("lease_token");
    canonicalize(&json!({"method": "host.tool.invoke", "params": Value::Object(p)}))
        .unwrap()
        .1
}

/// Independent oracle for `operation_digest`: builds the spec §5 binding
/// object by hand with `server_contract` set to the full closed Server object
/// and hashes its JCS bytes, never calling the crate helper.
fn expected_operation_digest(
    request_digest: &Sha256Digest,
    generation: u64,
    server_doc: &Value,
) -> Sha256Digest {
    canonicalize(&json!({
        "schema": "dolly.tool-operation-binding/v1",
        "request_digest": request_digest.to_canonical_string(),
        "tool_server_generation": generation,
        "server_contract": server_doc,
        "confirmation_decision": "not_required",
    }))
    .unwrap()
    .1
}

fn closed_registry_config() -> Value {
    let input_schema = json!({"type": "object", "additionalProperties": false, "required": ["path"], "properties": {"path": {"type": "string"}}});
    let output_schema = json!({"type": "object", "additionalProperties": false, "required": ["text"], "properties": {"text": {"type": "string"}}});
    let input_schema_digest = canonicalize(&input_schema).unwrap().1.to_canonical_string();
    let output_schema_digest = canonicalize(&output_schema)
        .unwrap()
        .1
        .to_canonical_string();
    let tool = json!({
        "upstream_name": "read_file",
        "description": "Read one authorized file.",
        "input_schema": input_schema,
        "input_schema_digest": input_schema_digest,
        "output_schema": output_schema,
        "output_schema_digest": output_schema_digest,
        "side_effect_class": "read_only",
        "idempotency": {"kind": "none"},
        "requires_confirmation": false,
        "enabled": true
    });
    json!({
        "schema": "dolly.tool-broker-config/v1",
        "servers": {
            "fs": {
                "enabled": true,
                "adapter": "mcp",
                "protocol_version": "2025-06-18",
                "transport": {
                    "kind": "stdio",
                    "package_id": "org.dolly.tools.fs",
                    "package_version": "1.0.0",
                    "package_digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
                    "executable": "bin/dolly-fs-tools",
                    "executable_digest": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
                    "args": ["--stdio"],
                    "secret_bindings": {}
                },
                "allowed_modules": ["module-a"],
                "limits": {
                    "startup_timeout_ms": 10000,
                    "request_timeout_ms": 30000,
                    "max_concurrency": 4,
                    "max_request_bytes": 1048576,
                    "max_response_bytes": 4194304
                },
                "tools": { "read-file": tool }
            }
        }
    })
}

fn admit(value: &Value) -> ResolvedToolBrokerConfig {
    match admit_config(serde_json::to_vec(value).unwrap().as_slice()) {
        AdmissionOutcome::Admitted(registry) => registry,
        AdmissionOutcome::Rejected(rejection) => panic!("config must admit: {rejection:?}"),
    }
}

fn admitted() -> ResolvedToolBrokerConfig {
    admit(&closed_registry_config())
}

/// A backend seam that counts every generation-selection call and always
/// selects generation 7 (mirrors the vector spy).
struct CountingBackend {
    calls: usize,
}

impl ResolutionBackend for CountingBackend {
    fn resolve_server(&mut self, _server_id: &str, _tool_name: &str) -> Option<u64> {
        self.calls += 1;
        Some(7)
    }
}

fn candidate(request_digest: Sha256Digest, config_revision: u64) -> InvokeCandidate {
    InvokeCandidate {
        operation_id: "0198ab31-6c44-7e8a-b2bb-000000000345".into(),
        tool_transaction_id: "0198ab31-6c44-7e8a-b2bb-000000000099".into(),
        module_id: "module-a".into(),
        activation_id: "0198ab31-6c44-7e8a-b2bb-000000000101".into(),
        config_revision,
        lease_token: "lease-token-1".into(),
        tool_server_id: "fs".into(),
        tool_name: "read-file".into(),
        tool_schema_digest: canonicalize(
            &closed_registry_config()["servers"]["fs"]["tools"]["read-file"]["input_schema"],
        )
        .unwrap()
        .1,
        arguments: json!({"path": "/etc/hostname"}),
        side_effect_class: "read_only".into(),
        idempotency_key: None,
        confirmation_id: None,
        deadline: "2026-08-21T00:00:00.000000Z".into(),
        request_digest,
    }
}

#[test]
fn equal_digest_replays_existing_identity_without_backend() {
    let registry = admitted();
    let digest = request_digest(&full_params());
    let existing = ExistingOperation {
        request_digest: digest.clone(),
        result: None,
    };
    let mut backend = CountingBackend { calls: 0 };
    let outcome = evaluate_invoke(
        &registry,
        "module-a",
        &candidate(digest.clone(), 11),
        Some(&existing),
        &mut backend,
    );
    match outcome {
        InvokeOutcome::Replayed { result } => {
            assert_eq!(result.status, dolly_tool_broker::ToolStatus::Absent);
        }
        other => panic!("expected replay, got {other:?}"),
    }
    assert_eq!(backend.calls, 0, "replay must not resolve a generation");
}

#[test]
fn digest_mismatch_is_rejected_before_backend() {
    let registry = admitted();
    let stored =
        digest_hex("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    let live =
        digest_hex("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    let existing = ExistingOperation {
        request_digest: stored,
        result: None,
    };
    let mut backend = CountingBackend { calls: 0 };
    let outcome = evaluate_invoke(
        &registry,
        "module-a",
        &candidate(live, 11),
        Some(&existing),
        &mut backend,
    );
    match outcome {
        InvokeOutcome::Rejected { result } => {
            let error = result.error.as_ref().expect("denial error");
            assert_eq!(error.code, ToolErrorCode::IdempotencyConflict);
        }
        other => panic!("expected identity conflict, got {other:?}"),
    }
    assert_eq!(backend.calls, 0, "conflict must not resolve a generation");
}

#[test]
fn accepted_invoke_selects_generation_and_mints_operation_digest() {
    let registry = admitted();
    let digest = request_digest(&full_params());
    let mut backend = CountingBackend { calls: 0 };
    let outcome = evaluate_invoke(
        &registry,
        "module-a",
        &candidate(digest.clone(), 11),
        None,
        &mut backend,
    );
    let binding = match outcome {
        InvokeOutcome::Authorized { binding } => binding,
        other => panic!("expected authorization, got {other:?}"),
    };
    assert_eq!(binding.tool_server_generation, 7);
    assert_eq!(backend.calls, 1, "authorization resolves exactly once");
    let expected =
        expected_operation_digest(&digest, 7, &closed_registry_config()["servers"]["fs"]);
    assert_eq!(binding.operation_digest, expected);
}

#[test]
fn request_digest_excludes_only_identity_volatile_keys() {
    let params = full_params();
    let expected = expected_request_digest(&params);
    assert_eq!(request_digest(&params), expected);

    // operation_id, deadline, and lease_token are NOT part of P (spec §5).
    let mut varied = params.clone();
    varied["operation_id"] = json!("0198ab31-6c44-7e8a-b2bb-000000000999");
    varied["deadline"] = json!("2026-08-21T01:00:00.000000Z");
    varied["lease_token"] = json!("lease-token-2");
    assert_eq!(request_digest(&varied), expected);

    // A P-bearing member still rotates the digest with its canonical bytes.
    let mut other = params.clone();
    other["payload"] = json!({"path": "/etc/hosts"});
    assert_ne!(request_digest(&other), expected);
}

#[test]
fn operation_digest_rotates_on_server_authority_change() {
    let digest = request_digest(&full_params());

    // Rotate one authority-bearing server field at a time while leaving the
    // resolved tool alias and `upstream_name` byte-identical.
    let variants: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
        (
            "limits",
            Box::new(|c| {
                c["servers"]["fs"]["limits"]["max_request_bytes"] = json!(2097152);
            }),
        ),
        (
            "allowed_modules",
            Box::new(|c| {
                c["servers"]["fs"]["allowed_modules"] = json!(["module-a", "module-b"]);
            }),
        ),
        (
            "transport.args",
            Box::new(|c| {
                c["servers"]["fs"]["transport"]["args"] = json!(["--verify-stdio"]);
            }),
        ),
    ];
    for (label, mutate) in &variants {
        let mut varied_config = closed_registry_config();
        mutate(&mut varied_config);
        let base_doc = &closed_registry_config()["servers"]["fs"];
        let varied_doc = &varied_config["servers"]["fs"];
        assert_ne!(
            canonicalize(base_doc).unwrap().1,
            canonicalize(varied_doc).unwrap().1,
            "{label}: server snapshots must differ"
        );

        let mut base_backend = CountingBackend { calls: 0 };
        let base = evaluate_invoke(
            &admitted(),
            "module-a",
            &candidate(digest.clone(), 11),
            None,
            &mut base_backend,
        );
        let base_binding = match base {
            InvokeOutcome::Authorized { binding } => binding,
            other => panic!("baseline expected authorization, got {other:?}"),
        };
        assert_eq!(
            base_binding.operation_digest,
            expected_operation_digest(&digest, 7, base_doc)
        );

        let varied_registry = admit(&varied_config);
        let mut varied_backend = CountingBackend { calls: 0 };
        let varied = evaluate_invoke(
            &varied_registry,
            "module-a",
            &candidate(digest.clone(), 11),
            None,
            &mut varied_backend,
        );
        let varied_binding = match varied {
            InvokeOutcome::Authorized { binding } => binding,
            other => panic!("{label}: expected authorization, got {other:?}"),
        };
        assert_eq!(
            varied_binding.operation_digest,
            expected_operation_digest(&digest, 7, varied_doc),
            "{label}: digest must bind the full server snapshot"
        );
        assert_ne!(
            base_binding.operation_digest, varied_binding.operation_digest,
            "{label}: authority-bearing change must rotate operation_digest"
        );
    }
}

#[test]
fn stale_authority_invocation_rejected_before_backend() {
    // A pre-existing identity row was minted under the current registry with
    // the current P (config_revision 11). A stale re-submission carrying an
    // older config_revision produces a different P => different request_digest
    // => TOOL_IDEMPOTENCY_CONFLICT before any server resolution; the backend
    // spy stays at zero.
    let current_params = full_params();
    let stored = request_digest(&current_params);

    let mut stale_params = current_params.clone();
    stale_params["config_revision"] = json!(10);
    let stale = request_digest(&stale_params);
    assert_ne!(stored, stale, "config_revision is part of P (spec §5)");

    let existing = ExistingOperation {
        request_digest: stored,
        result: None,
    };
    let mut backend = CountingBackend { calls: 0 };
    let outcome = evaluate_invoke(
        &admitted(),
        "module-a",
        &candidate(stale, 10),
        Some(&existing),
        &mut backend,
    );
    match outcome {
        InvokeOutcome::Rejected { result } => {
            let error = result.error.as_ref().expect("denial error");
            assert_eq!(error.code, ToolErrorCode::IdempotencyConflict);
        }
        other => panic!("expected identity conflict, got {other:?}"),
    }
    assert_eq!(
        backend.calls, 0,
        "stale invocation must not resolve a generation"
    );
}

#[test]
fn unknown_alias_status_absent_and_backend_never_called() {
    let registry = admitted();
    let digest = request_digest(&full_params());

    let mut invoke_backend = CountingBackend { calls: 0 };
    let mut ghost = candidate(digest.clone(), 11);
    ghost.tool_name = "ghost".into();
    let outcome = evaluate_invoke(&registry, "module-a", &ghost, None, &mut invoke_backend);
    match outcome {
        InvokeOutcome::PreResolutionDenied { result } => {
            let error = result.error.as_ref().expect("denial error");
            assert_eq!(error.code, ToolErrorCode::Unknown);
            assert_eq!(error.retryable, false);
        }
        other => panic!("expected pre-resolution denial, got {other:?}"),
    }
    assert_eq!(invoke_backend.calls, 0);

    let status = lookup_status(
        &registry,
        "module-a",
        "0198ab31-6c44-7e8a-b2bb-000000000345",
        None,
    );
    match status {
        StatusOutcome::Absent { result } => assert_eq!(result.error, None),
        other => panic!("expected absent status, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Version boundary: only 2025-06-18 admits; unknown, newer, and older fail
// closed with unsupported_protocol_version before any generation starts.
// ---------------------------------------------------------------------------

fn admit_with_protocol(protocol: &str) -> Result<(), String> {
    let mut config = closed_registry_config();
    config["servers"]["fs"]["protocol_version"] = json!(protocol);
    match admit_config(&serde_json::to_vec(&config).unwrap()) {
        AdmissionOutcome::Admitted(_) => Err(format!("{protocol} must not admit")),
        AdmissionOutcome::Rejected(rejection) => {
            assert_eq!(rejection.code, "TOOL_CONFIG_INVALID");
            assert_eq!(
                rejection.reason_text(),
                "unsupported_protocol_version",
                "{protocol}"
            );
            Ok(())
        }
    }
}

#[test]
fn only_2025_06_18_admits_and_unknown_newer_older_fail_closed() {
    match admit_config(
        serde_json::to_vec(&closed_registry_config())
            .unwrap()
            .as_slice(),
    ) {
        AdmissionOutcome::Admitted(_) => {}
        AdmissionOutcome::Rejected(rejection) => {
            panic!("frozen version must admit: {rejection:?}")
        }
    }
    for candidate in [
        "2026-07-28",
        "2025-06-19",
        "2025-06-17",
        "2024-11-05",
        "banana",
        "",
    ] {
        admit_with_protocol(candidate).expect(candidate);
    }
}
