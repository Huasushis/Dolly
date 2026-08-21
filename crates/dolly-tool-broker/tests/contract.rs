//! Contract tests for behaviors the vectors do not pin directly:
//! two-stage digest conflict/replay ordering, backend-spy zero-call proof on
//! denials, stage-2 generation selection, and fail-closed version boundary.

use std::cell::Cell;

use dolly_tool_broker::{
    AdmissionOutcome, ExistingOperation, InvokeCandidate, InvokeOutcome, ResolutionBackend,
    StatusOutcome, ToolErrorCode, admit_config, evaluate_invoke, lookup_status, operation_digest,
    request_digest,
};
use serde_json::{Value, json};

use dolly_canonical_json::{Sha256Digest, canonicalize};

fn digest_hex(full: &str) -> Sha256Digest {
    full.parse().expect("valid sha256 digest string")
}

fn closed_registry_config() -> Value {
    let input_schema = json!({"type": "object", "additionalProperties": false, "required": ["path"], "properties": {"path": {"type": "string", "minLength": 1, "maxLength": 4096}}});
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

fn admitted() -> dolly_tool_broker::ResolvedToolBrokerConfig {
    match admit_config(
        serde_json::to_vec(&closed_registry_config())
            .unwrap()
            .as_slice(),
    ) {
        AdmissionOutcome::Admitted(registry) => registry,
        AdmissionOutcome::Rejected(rejection) => panic!("config must admit: {rejection:?}"),
    }
}

/// A backend seam that counts every generation-selection call.
struct CountingBackend {
    calls: Cell<usize>,
}

impl ResolutionBackend for CountingBackend {
    fn resolve_server(&mut self, _server_id: &str, _tool_name: &str) -> Option<u64> {
        self.calls.set(self.calls.get() + 1);
        Some(7)
    }
}

fn candidate(in_schema_digest: Sha256Digest, request_digest: Sha256Digest) -> InvokeCandidate {
    InvokeCandidate {
        operation_id: "0198ab31-6c44-7e8a-b2bb-000000000345".into(),
        tool_transaction_id: "0198ab31-6c44-7e8a-b2bb-000000000099".into(),
        module_id: "module-a".into(),
        activation_id: "0198ab31-6c44-7e8a-b2bb-000000000101".into(),
        config_revision: 11,
        lease_token: "lease-token-1".into(),
        tool_server_id: "fs".into(),
        tool_name: "read-file".into(),
        tool_schema_digest: in_schema_digest,
        arguments: json!({"path": "/etc/hostname"}),
        side_effect_class: "read_only".into(),
        idempotency_key: None,
        confirmation_id: None,
        deadline: "2026-08-21T00:00:00.000000Z".into(),
        request_digest,
    }
}

fn tool_schema_digest() -> Sha256Digest {
    canonicalize(&closed_registry_config()["servers"]["fs"]["tools"]["read-file"]["input_schema"])
        .unwrap()
        .1
}

#[test]
fn equal_digest_replays_existing_identity_without_backend() {
    let registry = admitted();
    let digest = request_digest("op-1", "txn-1", &json!({"path": "/etc/hostname"}));
    let existing = ExistingOperation {
        request_digest: digest.clone(),
        result: None,
    };
    let mut backend = CountingBackend {
        calls: Cell::new(0),
    };
    let outcome = evaluate_invoke(
        &registry,
        "module-a",
        &candidate(tool_schema_digest(), digest.clone()),
        Some(&existing),
        &mut backend,
    );
    match outcome {
        InvokeOutcome::Replayed { result } => {
            assert_eq!(result.status, dolly_tool_broker::ToolStatus::Absent);
        }
        other => panic!("expected replay, got {other:?}"),
    }
    assert_eq!(
        backend.calls.get(),
        0,
        "replay must not resolve a generation"
    );
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
    let mut backend = CountingBackend {
        calls: Cell::new(0),
    };
    let outcome = evaluate_invoke(
        &registry,
        "module-a",
        &candidate(tool_schema_digest(), live),
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
        backend.calls.get(),
        0,
        "conflict must not resolve a generation"
    );
}

#[test]
fn accepted_invoke_selects_generation_and_mints_operation_digest() {
    let registry = admitted();
    let digest = request_digest("op-1", "txn-1", &json!({"path": "/etc/hostname"}));
    let mut backend = CountingBackend {
        calls: Cell::new(0),
    };
    let outcome = evaluate_invoke(
        &registry,
        "module-a",
        &candidate(tool_schema_digest(), digest.clone()),
        None,
        &mut backend,
    );
    let binding = match outcome {
        InvokeOutcome::Authorized { binding } => binding,
        other => panic!("expected authorization, got {other:?}"),
    };
    assert_eq!(binding.tool_server_generation, 7);
    assert_eq!(
        backend.calls.get(),
        1,
        "authorization resolves exactly once"
    );
    let expected = operation_digest(&digest, 7, "fs", "read_file");
    assert_eq!(binding.operation_digest, expected);
}

#[test]
fn unknown_alias_status_absent_and_backend_never_called() {
    let registry = admitted();
    let digest = request_digest("op-1", "txn-1", &json!({}));

    let mut invoke_backend = CountingBackend {
        calls: Cell::new(0),
    };
    let mut ghost = candidate(tool_schema_digest(), digest);
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
    assert_eq!(invoke_backend.calls.get(), 0);

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
    let bytes = serde_json::to_vec(&config).unwrap();
    match admit_config(&bytes) {
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
