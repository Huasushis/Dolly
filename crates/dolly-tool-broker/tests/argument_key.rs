//! RED contract tests for the REQ-TOOL-002 argument_key slice (written
//! BEFORE the implementation).
//!
//! REQ-TOOL-002 closes the `argument_key` idempotency contract at the
//! configuration and pre-resolution layers:
//!   - the registry MUST NOT drop the configured RFC 6901
//!     `argument_pointer`; a missing, empty, or malformed pointer MUST be
//!     config invalid;
//!   - at call time the pointer MUST resolve on the complete caller-supplied
//!     `arguments` object to a string exactly equal to
//!     `idempotency_key`; missing / non-string / unequal →
//!     `TOOL_INPUT_INVALID`, `not_applied`, `retryable:false`, backend spy 0;
//!   - caller data is not normalized, the key value is not mutated, and the
//!     key is not treated as a dedup attestation (no redispatch authority
//!     is implied by this slice).

use dolly_canonical_json::canonicalize;
use dolly_tool_broker::{
    AdmissionOutcome, ErrorOutcome, IdempotencyPolicy, InvokeCandidate, InvokeOutcome,
    ResolutionBackend, ResolvedToolBrokerConfig, ToolErrorCode, admit_config, evaluate_invoke,
    request_digest, resolve_json_pointer,
};
use serde_json::{Value, json};

fn argument_key_config(pointer: &str) -> Value {
    let input_schema = json!({"type": "object", "additionalProperties": false, "required": ["request_id", "value"], "properties": {"request_id": {"type": "string"}, "value": {"type": "string"}}});
    let output_schema = json!({"type": "object", "additionalProperties": false, "required": ["ok"], "properties": {"ok": {"type": "boolean"}}});
    let input_schema_digest = canonicalize(&input_schema).unwrap().1.to_canonical_string();
    let output_schema_digest = canonicalize(&output_schema)
        .unwrap()
        .1
        .to_canonical_string();
    let tool = json!({
        "upstream_name": "submit_order",
        "description": "Submit one idempotent order.",
        "input_schema": input_schema,
        "input_schema_digest": input_schema_digest,
        "output_schema": output_schema,
        "output_schema_digest": output_schema_digest,
        "side_effect_class": "idempotent_write",
        "idempotency": {"kind": "argument_key", "argument_pointer": pointer},
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
                "tools": { "submit-order": tool }
            }
        }
    })
}

fn admit_argument_key(pointer: &str) -> ResolvedToolBrokerConfig {
    let bytes = serde_json::to_vec(&argument_key_config(pointer)).unwrap();
    match admit_config(&bytes) {
        AdmissionOutcome::Admitted(registry) => registry,
        AdmissionOutcome::Rejected(rejection) => panic!("config must admit: {rejection:?}"),
    }
}

/// A backend seam that counts every call (denials must leave it at zero).
struct SpyBackend {
    calls: usize,
}

impl ResolutionBackend for SpyBackend {
    fn resolve_server(&mut self, _server_id: &str, _tool_name: &str) -> Option<u64> {
        self.calls += 1;
        Some(7)
    }
}

fn submit_order_schema_digest() -> dolly_canonical_json::Sha256Digest {
    canonicalize(
        &argument_key_config("/request_id")["servers"]["fs"]["tools"]["submit-order"]
            ["input_schema"],
    )
    .unwrap()
    .1
}

fn argument_key_candidate(key: Option<&str>, arguments: Value) -> InvokeCandidate {
    let params = json!({
        "operation_id": "0198ab31-6c44-7e8a-b2bb-000000000341",
        "tool_transaction_id": "0198ab31-6c44-7e8a-b2bb-000000000099",
        "module_id": "module-a",
        "activation_id": "0198ab31-6c44-7e8a-b2bb-000000000101",
        "config_revision": 11,
        "lease_token": "lease-token-1",
        "tool_server_id": "fs",
        "tool_name": "submit-order",
        "tool_schema_digest": submit_order_schema_digest().to_canonical_string(),
        "arguments": arguments.clone(),
        "side_effect_class": "idempotent_write",
        "idempotency_key": key.map(str::to_owned),
        "confirmation_id": null,
        "deadline": "2026-08-21T00:00:00.000Z"
    });
    InvokeCandidate {
        operation_id: params["operation_id"].as_str().unwrap().into(),
        tool_transaction_id: params["tool_transaction_id"].as_str().unwrap().into(),
        module_id: params["module_id"].as_str().unwrap().into(),
        activation_id: params["activation_id"].as_str().unwrap().into(),
        tool_server_id: params["tool_server_id"].as_str().unwrap().into(),
        tool_name: params["tool_name"].as_str().unwrap().into(),
        tool_schema_digest: submit_order_schema_digest(),
        arguments,
        side_effect_class: params["side_effect_class"].as_str().unwrap().into(),
        idempotency_key: key.map(str::to_owned),
        confirmation_id: None,
        deadline: params["deadline"].as_str().unwrap().into(),
        request_digest: request_digest(&params),
        config_revision: 11,
        lease_token: params["lease_token"].as_str().unwrap().into(),
    }
}

fn run_argument_key(key: Option<&str>, arguments: Value) -> (InvokeOutcome, usize) {
    let registry = admit_argument_key("/request_id");
    let mut backend = SpyBackend { calls: 0 };
    let candidate = argument_key_candidate(key, arguments);
    let outcome = evaluate_invoke(&registry, "module-a", &candidate, None, &mut backend);
    (outcome, backend.calls)
}

fn assert_denied_input_invalid(outcome: InvokeOutcome, calls: usize) {
    match outcome {
        InvokeOutcome::PreResolutionDenied { result } => {
            let error = result.error.as_ref().expect("denial error");
            assert_eq!(error.code, ToolErrorCode::InputInvalid);
            assert_eq!(error.retryable, false);
            assert_eq!(error.outcome, ErrorOutcome::NotApplied);
        }
        other => panic!("expected pre-resolution denial, got {other:?}"),
    }
    assert_eq!(calls, 0, "denial must not reach the backend");
}

// ---- config admission -----------------------------------------------------

#[test]
fn argument_key_admission_retains_pointer() {
    let registry = admit_argument_key("/request_id");
    let tool = &registry.servers()["fs"].tools["submit-order"];
    match &tool.idempotency {
        IdempotencyPolicy::ArgumentKey { argument_pointer } => {
            assert_eq!(argument_pointer, "/request_id");
        }
        other => panic!("expected retained ArgumentKey policy, got {other:?}"),
    }
}

#[test]
fn argument_key_missing_pointer_is_config_invalid() {
    let mut config = argument_key_config("/request_id");
    let idempotency = config
        .pointer_mut("/servers/fs/tools/submit-order/idempotency")
        .and_then(Value::as_object_mut)
        .expect("idempotency object");
    idempotency.remove("argument_pointer");
    match admit_config(&serde_json::to_vec(&config).unwrap()) {
        AdmissionOutcome::Rejected(rejection) => {
            assert_eq!(rejection.code, "TOOL_CONFIG_INVALID");
        }
        AdmissionOutcome::Admitted(_) => panic!("missing argument_pointer must be config invalid"),
    }
}

#[test]
fn argument_key_empty_pointer_is_config_invalid() {
    match admit_config(&serde_json::to_vec(&argument_key_config("")).unwrap()) {
        AdmissionOutcome::Rejected(rejection) => {
            assert_eq!(rejection.code, "TOOL_CONFIG_INVALID");
        }
        AdmissionOutcome::Admitted(_) => panic!("empty argument_pointer must be config invalid"),
    }
}

#[test]
fn argument_key_malformed_pointer_is_config_invalid() {
    // Truly malformed: not `/`-anchored, unknown or truncated `~` escapes.
    // (`/~01` is a legal decoder to `~1`; `/a b/` is schema-legal under the
    // pattern `(?:/(?:[^~/]|~[01])*)+`; those belong in the admit list.)
    for pointer in ["request_id", "/request_id~2", "/a~", "~foo", "/a/~b"] {
        let bytes = serde_json::to_vec(&argument_key_config(pointer)).unwrap();
        match admit_config(&bytes) {
            AdmissionOutcome::Rejected(rejection) => {
                assert!(rejection.code == "TOOL_CONFIG_INVALID", "{pointer:?}");
                let _ = rejection.reason_text();
            }
            AdmissionOutcome::Admitted(_) => {
                panic!("malformed pointer {pointer:?} must be config invalid")
            }
        }
    }
    // Well-formed pointer forms MUST admit: empty reference tokens, legal
    // escapes, member named "", whitespace member names.
    for pointer in ["/request/", "/a//b", "/~01", "/a b/", "//"] {
        let bytes = serde_json::to_vec(&argument_key_config(pointer)).unwrap();
        match admit_config(&bytes) {
            AdmissionOutcome::Admitted(_) => {}
            AdmissionOutcome::Rejected(rejection) => {
                panic!("well-formed pointer {pointer:?} must admit: {rejection:?}")
            }
        }
    }
}

// ---- call-time RFC 6901 resolution ---------------------------------------

#[test]
fn argument_key_exact_equal_value_is_authorized() {
    let (outcome, calls) = run_argument_key(
        Some("stable-request-1"),
        json!({"request_id": "stable-request-1", "value": "example"}),
    );
    match outcome {
        InvokeOutcome::Authorized { .. } => {}
        other => panic!("expected authorization, got {other:?}"),
    }
    assert_eq!(calls, 1, "authorization resolves the server exactly once");
}

#[test]
fn argument_key_missing_pointer_target_is_input_invalid() {
    let (outcome, calls) = run_argument_key(Some("stable-request-1"), json!({"value": "example"}));
    assert_denied_input_invalid(outcome, calls);
}

#[test]
fn argument_key_non_string_target_is_input_invalid() {
    let (outcome, calls) = run_argument_key(
        Some("stable-request-1"),
        json!({"request_id": 42, "value": "example"}),
    );
    assert_denied_input_invalid(outcome, calls);
}

#[test]
fn argument_key_unequal_value_is_input_invalid() {
    let (outcome, calls) = run_argument_key(
        Some("stable-request-1"),
        json!({"request_id": "different-key", "value": "example"}),
    );
    assert_denied_input_invalid(outcome, calls);
}

#[test]
fn argument_key_null_key_is_input_invalid() {
    let (outcome, calls) = run_argument_key(
        None,
        json!({"request_id": "stable-request-1", "value": "example"}),
    );
    assert_denied_input_invalid(outcome, calls);
}

// ---- RFC 6901 resolution semantics ---------------------------------------

#[test]
fn resolve_json_pointer_follows_rfc6901() {
    let doc = json!({
        "a": {"b~c": {"d/e": [1, 2, {"k": "v"}]}},
        "": "empty-member",
        "0": "leading-zero-member",
        "list": ["first", {"nested": 9}],
        "m~n": 1
    });
    // nested + ~1 (slash → `/`) and ~0 (tilde → `~`) escapes + array index:
    // the member "b~c" is spelled "b~0c", and "d/e" is spelled "d~1e".
    assert_eq!(
        resolve_json_pointer(&doc, "/a/b~0c/d~1e/2/k"),
        Some(&json!("v"))
    );
    assert_eq!(
        resolve_json_pointer(&doc, "/list/1/nested"),
        Some(&json!(9))
    );
    // root form: empty string is the whole document
    assert!(resolve_json_pointer(&doc, "").is_some());
    // empty member-name key
    assert_eq!(
        resolve_json_pointer(&doc, "/"),
        Some(&json!("empty-member"))
    );
    // "0" as a member name on an object
    assert_eq!(
        resolve_json_pointer(&doc, "/0"),
        Some(&json!("leading-zero-member"))
    );
    // RFC 6901 mandates MISSING results for: absent member, out-of-range
    // index, index on non-array, continuation into a scalar.
    assert_eq!(resolve_json_pointer(&doc, "/nope"), None);
    assert_eq!(resolve_json_pointer(&doc, "/list/2"), None);
    assert_eq!(resolve_json_pointer(&doc, "/list/"), None);
    assert_eq!(resolve_json_pointer(&doc, "/a/b~1c/d~0e/2/k"), None);
    assert_eq!(resolve_json_pointer(&doc, "/a/b~0c/d~1e/2/k/extra"), None);
    assert_eq!(
        resolve_json_pointer(&doc, "/a/b~0c/d~1e/2/k"),
        Some(&json!("v"))
    );
    // non-object continuation
    assert_eq!(resolve_json_pointer(&doc, "/list/0/x"), None);
}

// ---- caller data is not normalized, key is not a dedup attestation -------

#[test]
fn argument_key_eval_never_mutates_caller_arguments() {
    let arguments =
        json!({"request_id": "stable-request-1", "value": "example", "nested": {"deep": [1, 2]}});
    let before = arguments.clone();
    let registry = admit_argument_key("/request_id");
    let mut backend = SpyBackend { calls: 0 };
    let candidate = argument_key_candidate(Some("stable-request-1"), arguments);
    // The gate receives the candidate by immutable reference, so evaluation
    // cannot insert, replace, or normalize a single caller argument byte.
    let _ = evaluate_invoke(&registry, "module-a", &candidate, None, &mut backend);
    assert_eq!(
        candidate.arguments, before,
        "evaluation must not normalize or rewrite caller arguments"
    );
    assert_eq!(
        candidate.idempotency_key.as_deref(),
        Some("stable-request-1")
    );
}
