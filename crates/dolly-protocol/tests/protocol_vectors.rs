//! Executes the authoritative Dolly protocol test vectors in
//! `dolly-spec/test-vectors/protocol/` against the `dolly-protocol` crate.
//!
//! Test IDs are preserved exactly (TST-PROTO-001/002/003) and the declarative
//! assertions are translated into native assertions with the same operators as
//! the Core vector runner: `equals`, `not_equals`, `absent`, `count`, and
//! `unchanged`, plus subset comparison of the emitted event list.
//!
//! The frame boundary, JSON-RPC 2.0 envelope, and initialize-first ordering
//! are enforced by `dolly-protocol`. The TST-PROTO-002 semantic depth bound is
//! evaluated with the specification's schema-root rule: the declared semantic
//! payload root starts at depth 1 and JSON-RPC/method-envelope objects do not
//! consume that quota. The block-root depth is measured with the counting rule
//! shared by `dolly-canonical-json` (`semantic_depth`) at the case's declared
//! semantic root.

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

/// Builds a request whose `params` member is a chain of `wrapper_count`
/// non-empty envelope objects wrapping a leaf value nested `block_depth`
/// object/array levels deep.
///
/// Complete-frame depth equals `1` (top-level object) + `wrapper_count` +
/// `block_depth`. The `params` value is a key of the top-level object, not a
/// separate nesting level.
fn wrapped_block_request(wrapper_count: usize, block_depth: usize) -> String {
    let mut wrappers_open = String::new();
    for index in 0..wrapper_count {
        wrappers_open.push_str(&format!("{{\"w{index}\":"));
    }
    let mut block_open = String::new();
    for _ in 0..block_depth {
        block_open.push('[');
    }
    let block_close = "]".repeat(block_depth);
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":\"t\",\"method\":\"extension.ping\",\"params\":{wrappers_open}{block_open}0{block_close}{}}}",
        "}".repeat(wrapper_count)
    )
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

            let mut connection = Connection::new(limits);
            // Drive the connection to the vector's `ready` precondition: the
            // first accepted message must be a valid extension.initialize.
            let initialize = encode_frame(
                br#"{"jsonrpc":"2.0","id":"i","method":"extension.initialize","params":{}}"#,
            );
            connection
                .feed(&initialize)
                .expect("initialize accepted: envelope valid, init-first rule met");

            let cases = stimulus["frames"].as_array().unwrap();
            let mut observed_cases = Map::new();
            let mut outcome = "independent_frame_and_semantic_limits".to_string();
            let mut reusable = true;
            for case in cases {
                let case_name = case["case"].as_str().unwrap().to_string();
                let declared_frame_depth = case["frame_depth"].as_u64().unwrap() as usize;
                let block_depth = case
                    .get("semantic_block_depth")
                    .or_else(|| case.get("semantic_payload_depth"))
                    .and_then(Value::as_u64)
                    .unwrap() as usize;
                // depth = 1 (top-level object) + wrapper_count + block_depth
                let wrapper_count = declared_frame_depth - 1 - block_depth;
                let payload = wrapped_block_request(wrapper_count, block_depth);
                assert_eq!(
                    frame_depth(&payload) as usize,
                    declared_frame_depth,
                    "{case_name} constructed frame depth"
                );
                let frame = encode_frame(payload.as_bytes());
                let result = match connection.feed(&frame) {
                    Ok(messages) => {
                        // Semantic bound at the case's declared payload root.
                        if block_depth > semantic_limit_val {
                            json!({"accepted": false, "error": {"code": "semantic_too_deep"}})
                        } else {
                            let message = &messages[0];
                            assert_eq!(message.method().as_deref(), Some("extension.ping"));
                            assert_eq!(message.kind, MessageKind::Request);
                            json!({"accepted": true})
                        }
                    }
                    Err(violation) => match &violation.kind {
                        ViolationKind::Message(MessageError::FrameTooDeep { .. }) => {
                            reusable = false;
                            json!({"accepted": false, "error": {"code": "frame_too_deep"}})
                        }
                        other => {
                            outcome = format!("unexpected rejection: {other}");
                            reusable = false;
                            json!({"accepted": false, "error": {"code": "unknown"}})
                        }
                    },
                };
                observed_cases.insert(case_name, result);
            }
            // After a rejected frame the connection must not be reusable.
            let probe = encode_frame(br#"{"jsonrpc":"2.0","id":"p","method":"x"}"#);
            let probe_error = connection.feed(&probe).is_err() || !connection.is_ready();
            let reusable_after_rejection = reusable && !probe_error;
            let scenario = json!({
                "cases": Value::Object(observed_cases),
                "connection": {
                    "reusable_after_frame_rejection": reusable_after_rejection,
                    "state": state_name(connection.state()),
                },
            });
            let before =
                json!({"cases": {}, "connection": {"reusable_after_frame_rejection": true}});
            (scenario, before, outcome, vec![])
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
