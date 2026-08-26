//! Public worker-host binary: one durable-premise-verified Worker behind a
//! bounded framed control channel on stdin/stdout.
//!
//! Bootstrap input is deliberately minimal: the instance database path plus
//! the extension/server identity pair. Every spawn authority input — package
//! root, installed package path, digests, endpoint — is derived exclusively
//! from the closed durable Worker-start premise projected by the Host-owned
//! authority writer for the current revision. Nothing here accepts raw
//! package, policy, readiness, or dispatch authority from the caller.
//!
//! Control profile (frozen): four-byte big-endian length-prefixed UTF-8 JSON,
//! maximum payload 262144 bytes, wire depth 96, semantic depth 64. Any fatal
//! framing violation closes the connection; there is no resynchronization.
//! stdout carries frames only; diagnostics go to stderr.
//!
//! Per-call dispatch input is likewise identity-only: the daemon names one
//! operation and this process loads the exact authoritative Tool-call ledger
//! row itself, re-verifying every field before minting the Claim-bound intent
//! and touching the child. Settlement stays Rust-authoritative end to end.

use std::io::{Read, Write};
use std::process::exit;

use dolly_canonical_json::{CanonicalJsonValue, ParseLimits, canonicalize_with_limits};
use dolly_protocol::{FrameLimits, FrameReader, encode_frame};
use dolly_worker::premise::load_worker_start_config;
use dolly_worker::{Worker, WorkerStartConfig};

/// Frozen control-frame limits: 262144-byte cap, depth 96 wire / 64 semantic.
fn control_limits() -> FrameLimits {
    FrameLimits::new(262_144, 96, 64).expect("control frame limits are in contract")
}

const CONTROL_USAGE: &str = "usage: dolly-worker-host <db_path> <extension_alias> <server_id>";

fn fail(code: &str, message: &str) -> ! {
    eprintln!("dolly-worker-host: [{code}] {message}");
    exit(1);
}

/// Fixed-size stdin read buffer: bounded memory regardless of how long the
/// control channel stays open.
const READ_BUFFER_SIZE: usize = 8192;

#[derive(Clone, Copy, PartialEq, Eq)]
enum ControlFlow {
    Continue,
    Stop,
}

/// Incremental control loop: read stdin into a fixed-size buffer, feed the
/// capped `FrameReader`, and process each complete frame immediately while
/// stdin remains open. No unbounded buffering, no wait-for-EOF, and no
/// resynchronization after a fatal framing violation. On EOF,
/// `FrameReader::finish` rejects any partial or trailing frame as a typed
/// fatal error.
fn run_control_loop(worker: &mut Worker, server_id: &str) {
    let mut stdout = std::io::stdout();
    let mut reader = FrameReader::new(control_limits());
    let mut input = [0u8; READ_BUFFER_SIZE];
    let mut stdin = std::io::stdin().lock();
    loop {
        match stdin.read(&mut input) {
            Ok(0) => break,
            Ok(read) => {
                let payloads = reader
                    .feed(&input[..read])
                    .unwrap_or_else(|error| fail("FRAME_INVALID", &error.to_string()));
                for payload in payloads {
                    if handle_control_frame(worker, &mut stdout, server_id, &payload)
                        == ControlFlow::Stop
                    {
                        return;
                    }
                }
            }
            Err(error) => fail("WORKER_HOST_STDIN", &error.to_string()),
        }
    }
    if let Err(error) = reader.finish() {
        fail("FRAME_TRAILING", &error.to_string());
    }
}

fn handle_control_frame(
    worker: &mut Worker,
    stdout: &mut std::io::Stdout,
    server_id: &str,
    payload: &[u8],
) -> ControlFlow {
    let frame = parse_control_frame(payload);
    let op = require_string(&frame, "op");
    match op.as_str() {
        "status" => {
            write_frame(
                stdout,
                &serde_json::json!({
                    "v": 1,
                    "event": "status",
                    "state": "ready",
                    "server_id": server_id,
                }),
            );
        }
        "dispatch" => {
            let instance_id = require_string(&frame, "instance_id");
            let module_id = require_string(&frame, "module_id");
            let operation_id = require_string(&frame, "operation_id");
            let response = handle_dispatch(worker, &instance_id, &module_id, &operation_id);
            write_frame(stdout, &response);
        }
        "stop" => match worker.stop() {
            Ok(()) => {
                write_frame(stdout, &serde_json::json!({ "v": 1, "event": "stopped" }));
                return ControlFlow::Stop;
            }
            Err(error) => {
                write_frame(
                    stdout,
                    &serde_json::json!({
                        "v": 1,
                        "event": "stop_failed",
                        "detail": error.to_string(),
                    }),
                );
            }
        },
        other => {
            write_frame(
                stdout,
                &serde_json::json!({
                    "v": 1,
                    "event": "unknown_op",
                    "op": other,
                }),
            );
        }
    }
    ControlFlow::Continue
}

fn parse_control_frame(payload: &[u8]) -> CanonicalJsonValue {
    // Depth gate (semantic 64) runs inside canonicalization; the wire-depth
    // gate already ran in the framer. Unknown/loose JSON is refused closed.
    canonicalize_with_limits(
        &serde_json::from_slice::<serde_json::Value>(payload)
            .unwrap_or_else(|error| fail("CONTROL_JSON_INVALID", &error.to_string())),
        ParseLimits::new(64).expect("semantic depth is in contract"),
    )
    .map(|(bytes, _)| {
        CanonicalJsonValue::try_from(
            serde_json::from_slice::<serde_json::Value>(bytes.as_bytes())
                .unwrap_or_else(|error| fail("CONTROL_JSON_INVALID", &error.to_string())),
        )
        .unwrap_or_else(|error| fail("CONTROL_JSON_INVALID", &error.to_string()))
    })
    .unwrap_or_else(|error| fail("CONTROL_JSON_NOT_CANONICALIZABLE", &error.to_string()))
}

fn require_string(object: &CanonicalJsonValue, field: &str) -> String {
    match object {
        CanonicalJsonValue::Object(map) => match map.get(field) {
            Some(CanonicalJsonValue::String(value)) => value.clone(),
            _ => fail(
                "CONTROL_REQUEST_INVALID",
                &format!("field {field} must be a string"),
            ),
        },
        _ => fail("CONTROL_REQUEST_INVALID", "frame must be an object"),
    }
}

fn write_frame(stdout: &mut impl Write, value: &serde_json::Value) {
    let payload = serde_json::to_vec(value)
        .unwrap_or_else(|error| fail("WORKER_HOST_ENCODE", &error.to_string()));
    stdout
        .write_all(&encode_frame(&payload))
        .and_then(|_| stdout.flush())
        .unwrap_or_else(|error| fail("WORKER_HOST_STDOUT", &error.to_string()));
}

struct Bootstrap {
    config: WorkerStartConfig,
}

fn bootstrap() -> Bootstrap {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [db_path, extension_alias, server_id] = args.as_slice() else {
        fail("WORKER_HOST_ARGS", CONTROL_USAGE);
    };
    let config = load_worker_start_config(
        std::path::PathBuf::from(db_path),
        extension_alias,
        server_id,
    )
    .unwrap_or_else(|error| fail("WORKER_PREMISE_REFUSED", &error.to_string()));
    Bootstrap { config }
}

fn main() {
    let bootstrap = bootstrap();
    let worker = start_worker(&bootstrap.config);
    let mut worker = worker;

    let server_id = bootstrap.config.server_id.clone();
    write_frame(
        &mut std::io::stdout(),
        &serde_json::json!({
            "v": 1,
            "event": "started",
            "server_id": server_id,
        }),
    );

    // The Worker's Drop impl stops and reaps the retained child on any exit
    // path; an explicit `stop` frame returns from the control loop first.
    run_control_loop(&mut worker, &server_id);
}

#[allow(unreachable_code)]
fn start_worker(config: &WorkerStartConfig) -> Worker {
    #[cfg(feature = "test-support")]
    {
        if std::env::var_os("DOLLY_WORKER_TEST_SUPPORT").is_some() {
            return Worker::start_for_test(config.clone())
                .unwrap_or_else(|error| fail("WORKER_START_REFUSED", &error.to_string()));
        }
    }
    match Worker::start(config.clone()) {
        Ok(worker) => worker,
        Err(error) => fail("WORKER_START_REFUSED", &error.to_string()),
    }
}

fn handle_dispatch(
    worker: &mut Worker,
    instance_id: &str,
    module_id: &str,
    operation_id: &str,
) -> serde_json::Value {
    // The Worker re-verifies the exact authoritative row itself inside
    // dispatch_tools_call (load_exact + identity/digest checks fail closed
    // on any mismatch); the daemon supplies identity only.
    match worker.load_authorized_row(module_id, operation_id) {
        Ok(Some(row)) => {
            if row.operation_binding.instance_id != instance_id {
                return serde_json::json!({
                    "v": 1,
                    "event": "dispatch_refused",
                    "reason": "instance_identity_mismatch",
                });
            }
            let request_bytes = match row.operation_binding.recompute_outbound_payload() {
                Some(payload) => payload.as_ref().to_vec(),
                None => {
                    return serde_json::json!({
                        "v": 1,
                        "event": "dispatch_refused",
                        "reason": "outbound_payload_unavailable",
                    });
                }
            };
            match worker.dispatch_tools_call(&row, &request_bytes) {
                Ok(outcome) => serialize_outcome(outcome),
                Err(error) => serde_json::json!({
                    "v": 1,
                    "event": "dispatch_failed_closed",
                    "detail": error.to_string(),
                }),
            }
        }
        Ok(None) => serde_json::json!({
            "v": 1,
            "event": "dispatch_refused",
            "reason": "authoritative_tool_call_row_absent",
        }),
        Err(error) => serde_json::json!({
            "v": 1,
            "event": "dispatch_refused",
            "reason": format!("storage: {error}"),
        }),
    }
}

fn serialize_outcome(outcome: dolly_tool_coordinator::DispatchOutcome) -> serde_json::Value {
    match outcome {
        dolly_tool_coordinator::DispatchOutcome::Dispatched { record, .. } => {
            serde_json::json!({
                "v": 1,
                "event": "dispatched",
                "ledger_state": record.state.wire_name(),
            })
        }
        dolly_tool_coordinator::DispatchOutcome::Terminalized { record } => {
            serde_json::json!({
                "v": 1,
                "event": "terminalized",
                "ledger_state": record.state.wire_name(),
                "terminal_result_digest": record
                    .terminal_result_digest
                    .as_ref()
                    .map(|digest| digest.to_canonical_string()),
            })
        }
        other => serde_json::json!({
            "v": 1,
            "event": "dispatch_outcome_unhandled",
            "detail": format!("{other:?}"),
        }),
    }
}
