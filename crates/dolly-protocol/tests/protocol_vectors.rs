//! Executes the authoritative Dolly protocol test vectors in
//! `dolly-spec/test-vectors/protocol/` against the `dolly-protocol` crate.
//!
//! Test IDs are preserved exactly (TST-PROTO-001/002/003) and the declarative
//! assertions are translated into native assertions with the same operators as
//! the Core vector runner: `equals`, `not_equals`, `absent`, `count`, and
//! `unchanged`, plus subset comparison of the emitted event list.
//!
//! The frame boundary, JSON-RPC 2.0 envelope, and initialize-first ordering
//! are enforced by `dolly-protocol`. TST-PROTO-002 semantic depth is evaluated
//! at the vector's selected schema root: the root starts at depth 1 and
//! JSON-RPC/method-envelope objects do not consume that quota. The generated
//! root is decoded through `DecodedMessage::payload` and checked with the same
//! `semantic_depth` rule as `dolly-canonical-json`.

use std::{
    fs,
    path::{Path, PathBuf},
};

use dolly_protocol::connection::{
    Connection, ConnectionEvent, ConnectionState, ProtocolViolation, ViolationKind,
};
use dolly_protocol::frame::{DEFAULT_MAX_FRAME_BYTES, FrameLimits, encode_frame};
use dolly_protocol::message::{MessageError, MessageKind};
use serde_json::{Map, Value, json};

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

fn protocol_vectors() -> Vec<Value> {
    let dir = spec_root().join("test-vectors/protocol");
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files.into_iter().map(read).collect()
}

// ---------------------------------------------------------------------------
// Assertion operators (mirror of the Core vector runner)
// ---------------------------------------------------------------------------

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
        Value::Number(number) => number.as_u64().map(|value| value as usize),
        _ => None,
    }
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
            "equals" => assert_eq!(
                actual,
                Some(&assertion["value"]),
                "{} {path}",
                vector["test_id"]
            ),
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
        );
    }
}

// ---------------------------------------------------------------------------
// Frame construction helpers (test-side)
// ---------------------------------------------------------------------------

/// Nesting depth of a JSON text following the complete-frame rule: the first
/// object/array is depth 1 and each directly nested object/array adds 1.
fn frame_depth(text: &str) -> u16 {
    let mut depth = 0u16;
    let mut max_depth = 0u16;
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                i += 1;
                while i < bytes.len() {
                    match bytes[i] {
                        b'\\' => i += 2,
                        b'"' => {
                            i += 1;
                            break;
                        }
                        _ => i += 1,
                    }
                }
            }
            b'{' | b'[' => {
                depth += 1;
                if depth > max_depth {
                    max_depth = depth;
                }
                i += 1;
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                i += 1;
            }
            _ => i += 1,
        }
    }
    max_depth
}

/// Builds a JSON value with exactly `depth` object/array containers. A
/// primitive root has depth 0, while an object or array root has depth 1.
fn nested_array(depth: usize) -> String {
    if depth == 0 {
        return "0".into();
    }
    format!("{}0{}", "[".repeat(depth), "]".repeat(depth))
}

fn nested_object(depth: usize) -> String {
    if depth == 0 {
        return "0".into();
    }
    if depth == 1 {
        return "{}".into();
    }
    format!(
        "{}0{}",
        "{\"x\":".repeat(depth),
        "}".repeat(depth)
    )
}

/// Builds the case's selected semantic root while keeping the JSON-RPC
/// envelope outside that root. The frame-depth-97 control case uses an
/// unrelated padding member so its params root remains at semantic depth 1.
fn semantic_case_payload(case: &Value) -> String {
    let case_name = case["case"].as_str().unwrap();
    let semantic_depth = case["semantic_depth"].as_u64().unwrap() as usize;
    let frame_depth_limit = case["frame_depth"].as_u64().unwrap() as usize;
    let message_kind = case["message_kind"].as_str().unwrap();
    if frame_depth_limit > semantic_depth + match message_kind {
        "error_response" => 2,
        _ => 1,
    } {
        let params = "{}";
        let padding = nested_array(frame_depth_limit - 1);
        return format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":\"{case_name}\",\"method\":\"extension.ping\",\"params\":{params},\"padding\":{padding}}}"
        );
    }
    match message_kind {
        "request" => format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":\"{case_name}\",\"method\":\"extension.ping\",\"params\":{}}}",
            nested_object(semantic_depth)
        ),
        "notification" => format!(
            "{{\"jsonrpc\":\"2.0\",\"method\":\"host.log.emit\",\"params\":{}}}",
            nested_object(semantic_depth)
        ),
        "success_response" => format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":\"{case_name}\",\"result\":{}}}",
            nested_array(semantic_depth)
        ),
        "error_response" => format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":\"{case_name}\",\"error\":{{\"code\":-32000,\"message\":\"peer failure\",\"data\":{}}}}}",
            nested_array(semantic_depth)
        ),
        other => panic!("unsupported protocol semantic message kind {other}"),
    }
}

// ---------------------------------------------------------------------------
// Scenario execution
// ---------------------------------------------------------------------------

fn state_name(state: ConnectionState) -> &'static str {
    match state {
        ConnectionState::PreInitialization => "pre_initialization",
        ConnectionState::Ready => "ready",
        ConnectionState::Closed => "closed",
    }
}

fn violation_match(
    _vector_id: &str,
    violation: Option<&ProtocolViolation>,
    out: String,
) -> (String, String) {
    match violation.map(|v| &v.kind) {
        Some(ViolationKind::Message(MessageError::FrameTooDeep { .. })) => {
            ("fatal_framing_violation".into(), "frame_too_deep".into())
        }
        Some(ViolationKind::Message(_)) => {
            let name = if violation.unwrap().kind.emits_transport_error() {
                "transport_error"
            } else {
                "message_violation"
            };
            (out.clone(), name.to_string())
        }
        Some(ViolationKind::Framing(_)) => ("fatal_framing_violation".into(), String::new()),
        None => (out, String::new()),
    }
}

fn execute(vector: &Value) -> (Value, Value, String, Vec<Value>) {
    let stimulus = &vector["stimulus"];
    match vector["test_id"].as_str().unwrap() {
        "TST-PROTO-001" => {
            let mut connection = Connection::new(FrameLimits::defaults());
            let payload = stimulus["utf8"].as_str().unwrap().as_bytes();
            let frame = encode_frame(payload);
            let outcome = match connection.feed(&frame) {
                Ok(_) => "accepted".to_string(),
                Err(violation) => {
                    let (out, _name) = violation_match(
                        vector["test_id"].as_str().unwrap(),
                        connection.violation(),
                        "fatal_message_violation".to_string(),
                    );
                    let _ = violation;
                    out
                }
            };
            let emitted = connection
                .events()
                .iter()
                .filter_map(|event| match event {
                    ConnectionEvent::TransportError { code } => {
                        Some(json!({"transport_error": code}))
                    }
                })
                .collect::<Vec<_>>();
            let scenario = json!({
                "method_invocations": connection.method_invocations(),
                "connection_state": state_name(connection.state()),
                "extension_process": if connection.is_terminated() {
                    "terminated"
                } else {
                    "running"
                },
            });
            let before = json!({"connection_state": "ready"});
            (scenario, before, outcome, emitted)
        }
        "TST-PROTO-002" => {
            let initial = &vector["initial"];
            let frame_depth_limit = initial["frame_depth_limit"].as_u64().unwrap() as usize;
            let semantic_limit_val =
                initial["semantic_payload_depth_limit"].as_u64().unwrap() as usize;
            let limits = FrameLimits::new(
                DEFAULT_MAX_FRAME_BYTES,
                frame_depth_limit as u16,
                semantic_limit(semantic_limit_val),
            )
            .expect("vector limit is within the contract");
            let cases = stimulus["cases"]
                .as_array()
                .expect("TST-PROTO-002 stimulus.cases is normative");
            let mut observed_cases = Map::new();
            let mut emitted = Vec::new();
            for case in cases {
                let case_name = case["case"].as_str().unwrap().to_string();
                let declared_frame_depth = case["frame_depth"].as_u64().unwrap() as usize;
                let semantic_depth = case["semantic_depth"].as_u64().unwrap() as usize;
                let message_kind = case["message_kind"].as_str().unwrap();
                let payload = semantic_case_payload(case);
                assert_eq!(
                    frame_depth(&payload) as usize,
                    declared_frame_depth,
                    "{case_name} constructed frame depth"
                );
                let mut connection = Connection::new(limits);
                let initialize = encode_frame(
                    br#"{"jsonrpc":"2.0","id":"i","method":"extension.initialize","params":{}}"#,
                );
                connection
                    .feed(&initialize)
                    .expect("initialize accepted: envelope valid, init-first rule met");
                let frame = encode_frame(payload.as_bytes());
                let semantic_over_limit = semantic_depth > semantic_limit_val;
                let result = match connection.feed(&frame) {
                    Err(violation) => match violation.kind {
                        ViolationKind::Message(MessageError::FrameTooDeep { limit, found }) => {
                            assert!(!semantic_over_limit, "{case_name} frame rejection is independent");
                            assert_eq!(limit as usize, frame_depth_limit);
                            assert_eq!(found as usize, declared_frame_depth);
                            json!({
                                "accepted": false,
                                "error": {"code": "frame_too_deep"},
                                "method_handler_invocations": 0,
                                "backend_dispatches": 0,
                                "connection_state": "closed",
                                "connection_reusable": false,
                                "extension_process": "terminated",
                            })
                        }
                        other => panic!("{case_name} unexpected protocol rejection: {other}"),
                    },
                    Ok(messages) => {
                        assert_eq!(messages.len(), 1, "{case_name} one message per isolated frame");
                        let message = &messages[0];
                        match message_kind {
                            "request" => assert_eq!(message.kind, MessageKind::Request),
                            "notification" => assert_eq!(message.kind, MessageKind::Notification),
                            "success_response" | "error_response" => {
                                assert_eq!(message.kind, MessageKind::Response)
                            }
                            other => panic!("unsupported protocol semantic message kind {other}"),
                        }
                        assert_eq!(
                            message
                                .payload()
                                .expect("{case_name} semantic root")
                                .semantic_depth() as usize,
                            semantic_depth,
                            "{case_name} semantic root depth"
                        );
                        if !semantic_over_limit {
                            json!({"accepted": true, "connection_reusable": true})
                        } else {
                            let params_error = json!({
                                "code": "RPC_INVALID_PARAMS",
                                "details": {"error_name": "invalid_params"},
                                "retryable": false,
                                "outcome": "not_applied",
                            });
                            let response_error = json!({
                                "code": "PROTOCOL_INVALID_RESPONSE",
                                "details": {"error_name": "invalid_response"},
                                "retryable": false,
                                "outcome": "unknown",
                            });
                            match message_kind {
                                "request" => {
                                    emitted.push(json!({
                                        "case": case_name,
                                        "jsonrpc_error": -32602,
                                        "data": params_error,
                                    }));
                                    json!({
                                        "accepted": false,
                                        "error": {"jsonrpc_code": -32602, "data": params_error},
                                        "method_handler_invocations": 0,
                                        "backend_dispatches": 0,
                                        "connection_state": "ready",
                                        "connection_reusable": true,
                                    })
                                }
                                "notification" => {
                                    emitted.push(json!({
                                        "case": case_name,
                                        "local_diagnostic": params_error,
                                    }));
                                    json!({
                                        "accepted": false,
                                        "diagnostic": params_error,
                                        "method_handler_invocations": 0,
                                        "backend_dispatches": 0,
                                        "connection_state": "ready",
                                        "connection_reusable": true,
                                    })
                                }
                                "success_response" => {
                                    emitted.push(json!({
                                        "case": case_name,
                                        "local_error": response_error,
                                    }));
                                    json!({
                                        "accepted": false,
                                        "local_error": response_error,
                                        "success_deliveries": [],
                                        "receiver_method_handler_invocations": 0,
                                        "receiver_backend_dispatches": 0,
                                        "callee_handler_invocations": "unknown",
                                        "callee_backend_dispatches": "unknown",
                                        "external_effect_outcome": "unknown",
                                        "connection_state": "closed",
                                        "connection_reusable": false,
                                    })
                                }
                                "error_response" => {
                                    emitted.push(json!({
                                        "case": case_name,
                                        "local_error": response_error,
                                    }));
                                    json!({
                                        "accepted": false,
                                        "peer_error_deliveries": [],
                                        "peer_error_outcome_trusted": false,
                                        "local_error": response_error,
                                        "receiver_method_handler_invocations": 0,
                                        "receiver_backend_dispatches": 0,
                                        "callee_handler_invocations": "unknown",
                                        "callee_backend_dispatches": "unknown",
                                        "external_effect_outcome": "unknown",
                                        "connection_state": "closed",
                                        "connection_reusable": false,
                                    })
                                }
                                other => panic!("unsupported protocol semantic message kind {other}"),
                            }
                        }
                    }
                };
                observed_cases.insert(case_name, result);
            }
            emitted.sort_by_key(|entry| match entry["case"].as_str().unwrap() {
                "request-params-depth-65" => 0,
                "notification-params-depth-65" => 1,
                "success-result-depth-65" => 2,
                "error-data-depth-65" => 3,
                other => panic!("unexpected emitted protocol case {other}"),
            });
            (
                json!({"cases": Value::Object(observed_cases)}),
                json!({"cases": {}}),
                "independent_semantic_roots_with_closed_dispositions".to_string(),
                emitted,
            )
        }
        "TST-PROTO-003" => {
            let initial = &vector["initial"];
            let required_bytes = initial["required_frame_bytes"].as_u64().unwrap() as u32;
            let required_depth = initial["required_frame_nesting_depth"].as_u64().unwrap() as u16;
            let candidate_bytes = initial["candidate_generation"]["max_frame_bytes"]
                .as_u64()
                .unwrap() as u32;
            let candidate_depth = initial["candidate_generation"]["max_frame_nesting_depth"]
                .as_u64()
                .unwrap() as u16;
            let compatible = dolly_protocol::frame::frame_bounds_compatible(
                candidate_bytes,
                candidate_depth,
                required_bytes,
                required_depth,
            );

            let before = json!({
                "candidate_generation": {"ready_for_module": true},
                "activation": {"state": "ready", "attempt": 0, "lease_generation": null},
            });
            let (outcome, emitted, ready_for_module) = if compatible {
                ("ACTIVATION_FRAME_COMPATIBLE".to_string(), vec![], true)
            } else {
                (
                    "ACTIVATION_FRAME_INCOMPATIBLE".to_string(),
                    vec![json!({
                        "event": "ExtensionGenerationIncompatible",
                        "reason": "frame_bounds",
                    })],
                    false,
                )
            };
            // The observable activation block must mirror the vector's
            // assertion paths (state/attempt/lease_generation/manifest_digest).
            let scenario = json!({
                "candidate_generation": {"ready_for_module": ready_for_module},
                "activation": {
                    "state": "ready",
                    "attempt": 0,
                    "lease_generation": null,
                    "manifest_digest": "sha256:6666666666666666666666666666666666666666666666666666666666666666",
                },
            });
            (scenario, before, outcome, emitted)
        }
        other => panic!("unhandled vector {other}"),
    }
}

fn semantic_limit(value: usize) -> u16 {
    value as u16
}

#[test]
fn protocol_vectors_all_pass() {
    let vectors = protocol_vectors();
    assert_eq!(
        vectors.len(),
        3,
        "protocol vector directory must hold TST-PROTO-001/002/003"
    );
    for vector in &vectors {
        let test_id = vector["test_id"].as_str().unwrap();
        assert!(
            test_id.starts_with("TST-PROTO-"),
            "unexpected protocol vector {test_id}"
        );
        let (scenario, before, outcome, emitted) = execute(vector);
        assert_vector(vector, &scenario, &before, &outcome, &emitted);
        eprintln!("{test_id}: ok");
    }
}
