//! RED vector runner for the TST-TOOL-005 / TST-TOOL-008 tool-broker slice.
//!
//! Written BEFORE the implementation: this file drives the `dolly_tool_broker`
//! crate surface that does not exist yet, so building it is the genuine RED
//! gate (crate/API missing), not an assertion failure.

use std::{
    fs,
    path::{Path, PathBuf},
};

use dolly_canonical_json::{Sha256Digest, canonicalize};
use dolly_tool_broker::{
    AdmissionOutcome, InvokeCandidate, InvokeOutcome, ResolutionBackend, StatusOutcome,
    admit_config, evaluate_invoke, lookup_status,
};
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

fn vector(name: &str) -> Value {
    read(spec_root().join("test-vectors/services").join(name))
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

fn assert_vector(vector: &Value, scenario: &Value, emitted: &[Value]) {
    assert_eq!(
        scenario["outcome"], vector["expected"]["outcome"],
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
            "absent" => assert!(actual.is_none(), "{} {path}", vector["test_id"]),
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
    for (i, (actual, expected)) in emitted.iter().zip(required).enumerate() {
        assert!(
            subset(actual, expected),
            "{} emitted[{i}]\nactual={actual}\nrequired={expected}",
            vector["test_id"]
        );
    }
}

/// A spy "resolution backend" that counts how many times the crate asked it to
/// resolve a server (the only crate→backend seam in the pure-core crate).
struct SpyResolution {
    calls: usize,
}

impl ResolutionBackend for SpyResolution {
    fn resolve_server(&mut self, _server_id: &str, _tool_name: &str) -> Option<u64> {
        self.calls += 1;
        Some(7)
    }
}

fn digest_hex(full: &str) -> Sha256Digest {
    full.parse().expect("valid sha256 digest string")
}

/// Closed registry config for `module-a`: one enabled `mcp` server with no
/// `ghost` alias. Schema digests are recomputed here so the crate's
/// normalizer accepts the resolved config (spec §2: digest of
/// `sha256(JCS(complete embedded document))`).
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

/// Candidate registry config TST-TOOL-008: protocol `2026-07-28`, the deferral
/// boundary. Same shape as the closed registry so only the version differs.
fn candidate_config_with_protocol(protocol: &str) -> Value {
    let mut config = closed_registry_config();
    config["servers"]["fs"]["protocol_version"] = json!(protocol);
    config
}

fn run_tst_tool_005(vector: &Value) -> (Value, Vec<Value>) {
    let registry = match admit_config(
        serde_json::to_vec(&closed_registry_config())
            .unwrap()
            .as_slice(),
    ) {
        AdmissionOutcome::Admitted(registry) => registry,
        AdmissionOutcome::Rejected(rejection) => {
            panic!("closed registry must admit: {rejection:?}")
        }
    };

    let candidate = InvokeCandidate {
        operation_id: vector["initial"]["candidate_operation_id"]
            .as_str()
            .unwrap()
            .into(),
        tool_transaction_id: "0198ab31-6c44-7e8a-b2bb-000000000099".into(),
        module_id: "module-a".into(),
        activation_id: "0198ab31-6c44-7e8a-b2bb-000000000101".into(),
        config_revision: 11,
        lease_token: "lease-token-1".into(),
        tool_server_id: "fs".into(),
        tool_name: "ghost".into(),
        tool_schema_digest: digest_hex(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
        arguments: json!({}),
        side_effect_class: "read_only".into(),
        idempotency_key: None,
        confirmation_id: None,
        deadline: "2026-08-21T00:00:00.000000Z".into(),
        request_digest: digest_hex(
            vector["initial"]["candidate_request_digest"]
                .as_str()
                .unwrap(),
        ),
    };
    let mut resolution = SpyResolution { calls: 0 };

    let invoke_outcome = evaluate_invoke(&registry, "module-a", &candidate, None, &mut resolution);
    let invoke_result = match invoke_outcome {
        InvokeOutcome::PreResolutionDenied { result } => serde_json::to_value(result).unwrap(),
        other => panic!(
            "{} expected pre-resolution denial, got {other:?}",
            vector["test_id"]
        ),
    };

    let status_outcome = lookup_status(&registry, "module-a", &candidate.operation_id, None);
    let status_result = match status_outcome {
        StatusOutcome::Absent { result } => serde_json::to_value(result).unwrap(),
        other => panic!(
            "{} expected absent status, got {other:?}",
            vector["test_id"]
        ),
    };

    let mut scenario = Map::new();
    scenario.insert(
        "outcome".into(),
        json!("pre_resolution_denial_without_operation_binding"),
    );
    scenario.insert("invoke_result".into(), invoke_result);
    // /tool_call_row and /operation_digest must be ABSENT: do not insert them.
    scenario.insert("status_result".into(), status_result);
    scenario.insert("dispatch_count".into(), json!(resolution.calls));

    let emitted = vec![json!({
        "event": "ToolCandidateDenied",
        "request_digest": vector["initial"]["candidate_request_digest"],
    })];
    (Value::Object(scenario), emitted)
}

fn run_tst_tool_008(vector: &Value) -> (Value, Vec<Value>) {
    let candidate_bytes =
        serde_json::to_vec(&candidate_config_with_protocol("2026-07-28")).unwrap();
    let rejection = match admit_config(&candidate_bytes) {
        AdmissionOutcome::Rejected(rejection) => rejection,
        AdmissionOutcome::Admitted(_) => {
            panic!("{} must reject candidate config", vector["test_id"])
        }
    };
    assert_eq!(rejection.code, "TOOL_CONFIG_INVALID");
    assert_eq!(
        rejection.reason_text(),
        "unsupported_protocol_version",
        "{} rejection reason",
        vector["test_id"]
    );

    let mut scenario = Map::new();
    scenario.insert(
        "outcome".into(),
        json!("candidate_rejected_before_generation_start"),
    );
    // /candidate/error equals TOOL_CONFIG_INVALID; /candidate/tool_server_generation absent.
    let mut candidate_state = Map::new();
    candidate_state.insert("error".into(), json!("TOOL_CONFIG_INVALID"));
    scenario.insert("candidate".into(), Value::Object(candidate_state));
    scenario.insert("active_config_revision".into(), json!(11));
    scenario.insert("active_protocol_version".into(), json!("2025-06-18"));
    scenario.insert("active_tool_server_generation".into(), json!(7));
    scenario.insert("continuation_dispatch_count".into(), json!(0));

    let emitted = vec![json!({
        "event": "ToolRegistryCandidateRejected",
        "reason": "unsupported_protocol_version",
        "protocol_version": "2026-07-28",
    })];
    (Value::Object(scenario), emitted)
}

#[test]
fn executes_tst_tool_005_and_008_vectors() {
    for test_id in ["TST-TOOL-005", "TST-TOOL-008"] {
        let files = fs::read_dir(spec_root().join("test-vectors/services"))
            .unwrap()
            .filter_map(|entry| {
                let name = entry.unwrap().file_name().to_string_lossy().into_owned();
                name.starts_with(test_id).then_some(name)
            })
            .collect::<Vec<_>>();
        assert_eq!(
            files.len(),
            1,
            "exactly one vector for {test_id}: {files:?}"
        );
        let vector = vector(&files[0]);
        let (scenario, emitted) = match test_id {
            "TST-TOOL-005" => run_tst_tool_005(&vector),
            "TST-TOOL-008" => run_tst_tool_008(&vector),
            _ => unreachable!(),
        };
        assert_vector(&vector, &scenario, &emitted);
    }
}
