//! Authoritative G3 conformance for the production local daemon.

use dolly_canonical_json::{canonicalize, Sha256Digest};
use dolly_core_domain::WorkerEpoch;
use dolly_core_reducer::{
    CoreCommand, EnvironmentInput, InstallConfigCommand, InstallGraphCommand, TransitionOutcome,
};
use dolly_storage::SqliteCoreStore;
use dolly_worker::daemon::{
    DaemonCommand, DaemonError, DaemonGeneration, DaemonLifecycleIdentity, DaemonReadinessConfig,
    DaemonState, LocalDaemonSupervisor, RestartBounds,
};
use rusqlite::{types::Value as SqlValue, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tempfile::TempDir;

const G1_MATRIX: &str =
    include_str!("../../dolly-runtime/tests/fixtures/g1_runtime_conformance.json");
const G2_MATRIX: &str =
    include_str!("../../dolly-runtime/tests/fixtures/g2_extension_host_sdk_conformance.json");
const G3_MATRIX: &str =
    include_str!("../../dolly-runtime/tests/fixtures/g3_operable_local_conformance.json");
const EXTENSION_ID: &str = "org.example.extension";
const WORKER_EPOCH: &str = "0198ab31-6c44-7e8a-b2bb-000000000110";
const EXTENSION_CONNECTION_ID: &str = "g1-extension-connection";
const WORKER_EPOCH_FENCE: i64 = 17;
const EXTENSION_GENERATION: i64 = 7;
const LEASE_ID: &str = "g2-exec-lease-id-001";
const OWNER_SEED: &str = "g3-owner-seed";

fn canonical_digest(value: &Value) -> String {
    canonicalize(value)
        .expect("fixture value must be canonical JSON")
        .1
        .to_canonical_string()
}

fn input() -> EnvironmentInput {
    EnvironmentInput {
        now: "2026-08-27T00:00:00.000000Z".into(),
        ..Default::default()
    }
}

fn graph_input() -> EnvironmentInput {
    EnvironmentInput {
        graph_revision: Some(1),
        descriptor_revision: Some(1),
        ..input()
    }
}

fn descriptor(module_id: &str) -> Value {
    json!({
        "schema": "dolly.module-descriptor/v1",
        "module_id": module_id,
        "descriptor_revision": 1,
        "display_name": module_id,
        "accepts": {"summary":"input","part_kinds":["text"],"action_names":[]},
        "emits": {"summary":"output","part_kinds":["text"],"action_names":[]},
        "actions": [],
        "activation_replay_contract": {"mode":"fenced_replay","evidence":"pure_compute","ledger":null},
        "trust": "trusted",
        "metadata": {"org.example.extension":{"capabilities":["host.block.get"]}}
    })
}

fn graph_snapshot(module_id: &str) -> Value {
    let descriptor = descriptor(module_id);
    let mut descriptors = serde_json::Map::new();
    descriptors.insert(
        module_id.into(),
        json!({
            "module_id": module_id,
            "descriptor_revision": 1,
            "source_descriptor_digest": canonical_digest(&descriptor),
            "value": descriptor
        }),
    );
    json!({
        "receiving_module": module_id,
        "input_pages": {},
        "output_pages": {},
        "subscriptions": {},
        "descriptors": descriptors,
        "authorized_metadata_namespaces": ["org.example.extension"],
        "authorized_action_names": []
    })
}

fn install_config(store: &mut SqliteCoreStore<'_>) {
    let effective_config = json!({
        "execution_timeout_ms": 120000,
        "lease_grace_ms": 30000,
        "fencing_grace_ms": 5000,
        "extension_connection_id": EXTENSION_CONNECTION_ID,
        "worker_epoch": WORKER_EPOCH,
        "worker_epoch_fence": WORKER_EPOCH_FENCE
    });
    let transition = store
        .transact(
            &CoreCommand::InstallConfig(InstallConfigCommand {
                command_id: "g3-production-config-001".into(),
                revision: 1,
                digest: canonical_digest(&effective_config),
                effective_config,
            }),
            &input(),
        )
        .expect("configuration transaction must execute");
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    store
        .bootstrap_host_connection()
        .expect("Host connection bootstrap");
}

fn install_graph(store: &mut SqliteCoreStore<'_>, module_id: &str) {
    let graph = graph_snapshot(module_id);
    let transition = store
        .transact(
            &CoreCommand::InstallGraph(InstallGraphCommand {
                command_id: "g3-production-graph-001".into(),
                revision: 1,
                digest: canonical_digest(&graph),
                graph,
            }),
            &graph_input(),
        )
        .expect("graph transaction must execute");
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
}

fn manifest(case: &Value) -> Value {
    let mut manifest = json!({
        "schema": "dolly.activation-manifest/v1",
        "activation_id": case["activation_id"],
        "module_id": case["module_id"],
        "reason": "timer",
        "created_at": "2026-08-27T00:00:00.000000Z",
        "graph_revision": 1,
        "config_revision": 1,
        "descriptor_revision": 1,
        "effective_config": {
            "execution_timeout_ms": 120000,
            "lease_grace_ms": 30000,
            "fencing_grace_ms": 5000,
            "extension_connection_id": EXTENSION_CONNECTION_ID,
            "worker_epoch": WORKER_EPOCH,
            "worker_epoch_fence": WORKER_EPOCH_FENCE
        },
        "effective_config_digest": null,
        "effective_config_schema_digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "input_items": [],
        "cursor_spans": [],
        "lossy_gaps": [],
        "output_page_ids": [],
        "neighbor_descriptors": [],
        "required_frame_bytes": 2048,
        "required_frame_nesting_depth": 10,
        "deadline": "2026-08-27T00:02:00.000000Z",
        "manifest_digest": null
    });
    manifest["effective_config_digest"] = json!(canonical_digest(&manifest["effective_config"]));
    let mut digestable = manifest.clone();
    digestable
        .as_object_mut()
        .expect("manifest must be an object")
        .remove("manifest_digest");
    manifest["manifest_digest"] = json!(canonical_digest(&digestable));
    manifest
}

struct PreparedInvocation {
    module_id: String,
    activation_id: String,
    lease_token: String,
    manifest: Value,
    worker_epoch: String,
    extension_connection_id: String,
    worker_epoch_fence: i64,
    incarnation_revision: i64,
    extension_generation: i64,
}

fn prepare_database(path: &Path, case: &Value) -> PreparedInvocation {
    let mut connection = Connection::open(path).expect("file-backed SQLite");
    let mut store = SqliteCoreStore::new(&mut connection).expect("core schema");
    install_config(&mut store);
    let module_id = case["module_id"].as_str().expect("G1 module_id").to_owned();
    install_graph(&mut store, &module_id);
    let authority = store
        .authenticated_host_connection()
        .expect("current Host authority");
    let activation_id = case["activation_id"]
        .as_str()
        .expect("G1 activation_id")
        .to_owned();
    let lease_token = case["lease_token"]
        .as_str()
        .expect("G1 lease token")
        .to_owned();
    let manifest = manifest(case);
    store
        .install_host_capability_grant(
            &authority,
            EXTENSION_ID,
            &module_id,
            EXTENSION_GENERATION,
            manifest["descriptor_revision"]
                .as_i64()
                .expect("descriptor revision"),
            &canonical_digest(&descriptor(&module_id)),
            manifest["config_revision"]
                .as_i64()
                .expect("configuration revision"),
            manifest["manifest_digest"]
                .as_str()
                .expect("manifest digest"),
            manifest["graph_revision"].as_i64().expect("graph revision"),
            &canonical_digest(&graph_snapshot(&module_id)),
            &["host.block.get"],
        )
        .expect("Host capability grant");
    PreparedInvocation {
        module_id,
        activation_id,
        lease_token,
        manifest,
        worker_epoch: authority.worker_epoch().to_string(),
        extension_connection_id: authority.extension_connection_id().to_owned(),
        worker_epoch_fence: authority.worker_epoch_fence(),
        incarnation_revision: authority.incarnation_revision(),
        extension_generation: EXTENSION_GENERATION,
    }
}

fn owner_token(seed: &str, generation: u64) -> String {
    Sha256Digest::compute(format!("{seed}:{generation}").as_bytes()).to_canonical_string()
}

fn endpoint(temp_dir: &TempDir, name: &str) -> PathBuf {
    temp_dir.path().join(format!("{name}.sock"))
}

fn production_binary_path() -> PathBuf {
    let current_exe = std::env::current_exe().expect("G3 test executable path");
    let binary = current_exe
        .parent()
        .and_then(Path::parent)
        .expect("target debug directory")
        .join("dolly-local-daemon");
    assert!(
        binary.is_file(),
        "production daemon binary must be built: {binary:?}"
    );
    binary
}

fn daemon_command(
    prepared: &PreparedInvocation,
    database_path: &Path,
    endpoint: &Path,
    module_id: &str,
    incarnation_revision: i64,
    owner_seed: &str,
) -> DaemonCommand {
    DaemonCommand::new(production_binary_path())
        .expect("production daemon command")
        .env(
            "DOLLY_DATABASE_PATH",
            database_path.as_os_str().to_os_string(),
        )
        .env(
            "DOLLY_CONTROL_ENDPOINT",
            endpoint.as_os_str().to_os_string(),
        )
        .env("DOLLY_EXTENSION_ID", EXTENSION_ID)
        .env("DOLLY_MODULE_ID", module_id)
        .env("DOLLY_OWNER_SEED", owner_seed)
        .env(
            "DOLLY_WORKER_EPOCH_FENCE",
            prepared.worker_epoch_fence.to_string(),
        )
        .env(
            "DOLLY_INCARNATION_REVISION",
            incarnation_revision.to_string(),
        )
}

fn daemon_readiness(
    prepared: &PreparedInvocation,
    extension_generation: i64,
) -> DaemonReadinessConfig {
    let identity = DaemonLifecycleIdentity::new(
        EXTENSION_ID,
        &prepared.module_id,
        &prepared.extension_connection_id,
        prepared.incarnation_revision,
        prepared
            .worker_epoch
            .parse::<WorkerEpoch>()
            .expect("WorkerEpoch"),
        prepared.worker_epoch_fence,
        extension_generation,
        &prepared.extension_connection_id,
    )
    .expect("daemon lifecycle identity");
    DaemonReadinessConfig::new(
        &prepared.worker_epoch,
        &prepared.extension_connection_id,
        OWNER_SEED,
    )
    .expect("daemon readiness")
    .with_lifecycle_identity(identity)
    .with_storage_ready(true)
    .with_startup_timeout(Duration::from_secs(5))
    .with_stop_timeout(Duration::from_secs(1))
    .with_restart_bounds(
        RestartBounds::new(
            Duration::from_millis(1),
            Duration::from_millis(8),
            Duration::from_secs(1),
            3,
        )
        .expect("daemon restart bounds"),
    )
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
struct ControlRequest {
    operation: &'static str,
    generation: u64,
    control_channel_id: String,
    owner_token: String,
    activation_id: String,
    module_id: String,
    lease_id: String,
    lease_token: String,
    extension_generation: i64,
    now: String,
    manifest: Value,
}

#[derive(Debug, Deserialize)]
struct ControlResponse {
    accepted: bool,
    code: String,
    activation_id: Option<String>,
    frame_digest: Option<String>,
    durable_commit_seq: Option<i64>,
}

fn control_request(prepared: &PreparedInvocation, generation: u64) -> ControlRequest {
    ControlRequest {
        operation: "module.activate",
        generation,
        control_channel_id: prepared.extension_connection_id.clone(),
        owner_token: owner_token(OWNER_SEED, generation),
        activation_id: prepared.activation_id.clone(),
        module_id: prepared.module_id.clone(),
        lease_id: LEASE_ID.to_owned(),
        lease_token: prepared.lease_token.clone(),
        extension_generation: prepared.extension_generation,
        now: input().now,
        manifest: prepared.manifest.clone(),
    }
}

fn send_request(endpoint: &Path, request: &ControlRequest) -> ControlResponse {
    let mut stream = UnixStream::connect(endpoint).expect("production control endpoint");
    let mut bytes = serde_json::to_vec(request).expect("control request JSON");
    bytes.push(b'\n');
    stream.write_all(&bytes).expect("control request write");
    stream
        .shutdown(Shutdown::Write)
        .expect("control request shutdown");
    let mut response_bytes = Vec::new();
    stream
        .read_to_end(&mut response_bytes)
        .expect("control response read");
    serde_json::from_slice(&response_bytes).expect("control response JSON")
}

fn durable_snapshot(path: &Path) -> Vec<(String, Vec<Vec<SqlValue>>)> {
    let connection = Connection::open(path).expect("durable SQLite");
    let table_names = {
        let mut statement = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .expect("durable table listing");
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("durable table query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("durable table names")
    };
    table_names
        .into_iter()
        .map(|table_name| {
            let quoted_name = format!("\"{}\"", table_name.replace('"', "\"\""));
            let mut statement = connection
                .prepare(&format!("SELECT * FROM {quoted_name}"))
                .expect("durable table contents");
            let column_count = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    (0..column_count)
                        .map(|index| row.get(index))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .expect("durable row query")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("durable rows");
            (table_name, rows)
        })
        .collect()
}

fn assert_startup_rejected(
    prepared: &PreparedInvocation,
    database_path: &Path,
    endpoint: &Path,
    module_id: &str,
    incarnation_revision: i64,
    owner_seed: &str,
) {
    let readiness = daemon_readiness(prepared, prepared.extension_generation);
    let command = daemon_command(
        prepared,
        database_path,
        endpoint,
        module_id,
        incarnation_revision,
        owner_seed,
    );
    let mut supervisor = LocalDaemonSupervisor::with_readiness_at_generation(
        command,
        readiness,
        DaemonGeneration::new(prepared.extension_generation as u64).expect("generation"),
    );
    let result = supervisor.start();
    assert!(
        matches!(
            result,
            Err(DaemonError::ReadinessUnavailable)
                | Err(DaemonError::ReadinessTimeout)
                | Err(DaemonError::ReadinessMismatch)
                | Err(DaemonError::Process(_))
        ),
        "invalid production startup must fail closed: {result:?}"
    );
    let _ = supervisor.stop();
    let _ = fs::remove_file(endpoint);
    assert!(!endpoint.exists());
}

fn assert_rejected_without_mutation(
    endpoint: &Path,
    request: &ControlRequest,
    before: &[(String, Vec<Vec<SqlValue>>)],
    code: &str,
    database_path: &Path,
) {
    let response = send_request(endpoint, request);
    assert!(!response.accepted);
    assert_eq!(response.code, code);
    assert!(response.activation_id.is_none());
    assert!(response.frame_digest.is_none());
    assert!(response.durable_commit_seq.is_none());
    assert_eq!(durable_snapshot(database_path), before);
}

#[test]
fn g3_operable_local_001_uses_production_daemon_process_and_durable_g2_result() {
    let g1 = document(G1_MATRIX, "accepted G1");
    let g2 = document(G2_MATRIX, "accepted G2");
    let g3 = document(G3_MATRIX, "G3");
    let source_boundary = &g3["source_boundary"];
    let g1_case = case(&g1, "G1-EXEC-001", "accepted G1");
    let g2_case = case(&g2, "G2-ADMISSION-001", "accepted G2");
    let g3_case = case(&g3, "G3-OPERABLE-LOCAL-001", "G3");

    assert_eq!(
        source_boundary["g1_fixture"],
        "crates/dolly-runtime/tests/fixtures/g1_runtime_conformance.json"
    );
    assert_eq!(
        source_boundary["g2_fixture"],
        "crates/dolly-runtime/tests/fixtures/g2_extension_host_sdk_conformance.json"
    );
    assert_eq!(source_boundary["g1_case"], g1_case["id"]);
    assert_eq!(source_boundary["g2_case"], g2_case["id"]);
    assert_eq!(g1_case["expected"], "product_red");
    assert_eq!(g2_case["expected"], "product_red");
    assert_eq!(g2_case["source_case"], g1_case["id"]);
    assert_eq!(g3_case["expected"], "pass");
    assert_eq!(g3_case["source_case"], g2_case["id"]);
    assert_eq!(g3_case["fences"].as_array().expect("G3 fences").len(), 11);
    assert_eq!(g3_case["effect_boundary"], "before external I/O");

    let temp_dir = TempDir::new().expect("G3 temporary directory");
    let database_path = temp_dir.path().join("core.sqlite");
    let endpoint_path = endpoint(&temp_dir, "primary");
    let prepared = prepare_database(&database_path, g1_case);
    let readiness = daemon_readiness(&prepared, prepared.extension_generation);
    let command = daemon_command(
        &prepared,
        &database_path,
        &endpoint_path,
        &prepared.module_id,
        prepared.incarnation_revision,
        OWNER_SEED,
    );
    let initial_generation =
        DaemonGeneration::new(prepared.extension_generation as u64).expect("initial generation");
    let mut supervisor =
        LocalDaemonSupervisor::with_readiness_at_generation(command, readiness, initial_generation);
    let generation = supervisor.start().expect("production daemon readiness");
    assert_eq!(supervisor.state(), DaemonState::Running(generation));
    assert!(endpoint_path.exists());

    let guard = supervisor
        .acquire_work_guard(generation)
        .expect("ready production daemon work guard");
    let before_operation = durable_snapshot(&database_path);
    let response = send_request(
        &endpoint_path,
        &control_request(&prepared, generation.value()),
    );
    assert!(response.accepted);
    assert_eq!(response.code, "activation_dispatched");
    assert_eq!(
        response.activation_id.as_deref(),
        Some(prepared.activation_id.as_str())
    );
    let frame_digest = response.frame_digest.clone().expect("frame digest");
    let durable_commit_seq = response
        .durable_commit_seq
        .expect("durable commit sequence");
    assert_ne!(durable_snapshot(&database_path), before_operation);
    let after_operation = durable_snapshot(&database_path);
    let mut connection = Connection::open(&database_path).expect("durable SQLite after operation");
    let store = SqliteCoreStore::new(&mut connection).expect("core schema after operation");
    let snapshot = store.snapshot().expect("durable production result");
    assert_eq!(
        snapshot
            .activations
            .get(&prepared.activation_id)
            .expect("activation")
            .state,
        dolly_core_reducer::ActivationState::Dispatched
    );
    assert_eq!(
        snapshot
            .leases
            .get(LEASE_ID)
            .and_then(|lease| lease.get("frame_digest"))
            .and_then(Value::as_str),
        Some(frame_digest.as_str())
    );
    assert!(snapshot
        .journal
        .iter()
        .any(|event| event.command_id == "dolly-local-daemon-dispatch"));
    assert!(snapshot
        .journal
        .iter()
        .any(|event| event.commit_seq == durable_commit_seq));
    assert!(guard.is_usable());

    let mut wrong_generation = control_request(&prepared, generation.value());
    wrong_generation.generation += 1;
    assert_rejected_without_mutation(
        &endpoint_path,
        &wrong_generation,
        &after_operation,
        "request_fence_mismatch",
        &database_path,
    );
    let mut wrong_owner = control_request(&prepared, generation.value());
    wrong_owner.owner_token = owner_token("wrong-owner", generation.value());
    assert_rejected_without_mutation(
        &endpoint_path,
        &wrong_owner,
        &after_operation,
        "request_fence_mismatch",
        &database_path,
    );
    let mut wrong_premise = control_request(&prepared, generation.value());
    wrong_premise.module_id = "other-module".into();
    assert_rejected_without_mutation(
        &endpoint_path,
        &wrong_premise,
        &after_operation,
        "request_fence_mismatch",
        &database_path,
    );

    let mut cross_generation = control_request(&prepared, generation.value());
    cross_generation.extension_generation = prepared.extension_generation + 1;
    assert_rejected_without_mutation(
        &endpoint_path,
        &cross_generation,
        &after_operation,
        "request_fence_mismatch",
        &database_path,
    );

    let mut wrong_revision = control_request(&prepared, generation.value());
    wrong_revision.manifest["config_revision"] = json!(2);
    assert_rejected_without_mutation(
        &endpoint_path,
        &wrong_revision,
        &after_operation,
        "request_fence_mismatch",
        &database_path,
    );

    let mut wrong_digest = control_request(&prepared, generation.value());
    wrong_digest.manifest["manifest_digest"] =
        json!("sha256:9999999999999999999999999999999999999999999999999999999999999999");
    assert_rejected_without_mutation(
        &endpoint_path,
        &wrong_digest,
        &after_operation,
        "request_fence_mismatch",
        &database_path,
    );

    let mut post_controls =
        Connection::open(&database_path).expect("durable SQLite after controls");
    let post_store = SqliteCoreStore::new(&mut post_controls).expect("core schema after controls");
    let post_snapshot = post_store
        .snapshot()
        .expect("durable snapshot after controls");
    assert_eq!(
        post_snapshot
            .journal
            .iter()
            .filter(|event| event.command_id == "dolly-local-daemon-dispatch")
            .count(),
        1,
        "valid dispatch must execute exactly once; rejected controls consume no dispatch"
    );
    assert_eq!(
        post_snapshot.activations[&prepared.activation_id].state,
        dolly_core_reducer::ActivationState::Dispatched
    );

    supervisor.stop().expect("production daemon stop");
    assert!(!guard.is_usable());
    assert!(matches!(
        supervisor.restart(),
        Err(DaemonError::FreshLifecycleIdentityRequired)
    ));
    let fresh_identity = DaemonLifecycleIdentity::new(
        EXTENSION_ID,
        &prepared.module_id,
        &prepared.extension_connection_id,
        prepared.incarnation_revision,
        prepared
            .worker_epoch
            .parse::<WorkerEpoch>()
            .expect("WorkerEpoch"),
        prepared.worker_epoch_fence,
        prepared.extension_generation + 1,
        &prepared.extension_connection_id,
    )
    .expect("fresh lifecycle identity");
    let restarted_generation = supervisor
        .restart_with_identity(fresh_identity)
        .expect("production daemon restart");
    assert_eq!(
        supervisor.state(),
        DaemonState::Running(restarted_generation)
    );
    let before_stale = durable_snapshot(&database_path);
    let stale_request = control_request(&prepared, generation.value());
    assert_rejected_without_mutation(
        &endpoint_path,
        &stale_request,
        &before_stale,
        "request_fence_mismatch",
        &database_path,
    );
    supervisor.stop().expect("production daemon final stop");
    let _ = fs::remove_file(&endpoint_path);
    assert!(!endpoint_path.exists());

    let wrong_owner_endpoint = endpoint(&temp_dir, "wrong-owner");
    assert_startup_rejected(
        &prepared,
        &database_path,
        &wrong_owner_endpoint,
        &prepared.module_id,
        prepared.incarnation_revision,
        "wrong-owner-seed",
    );
    let wrong_module_endpoint = endpoint(&temp_dir, "wrong-module");
    assert_startup_rejected(
        &prepared,
        &database_path,
        &wrong_module_endpoint,
        "other-module",
        prepared.incarnation_revision,
        OWNER_SEED,
    );
    let wrong_revision_endpoint = endpoint(&temp_dir, "wrong-revision");
    assert_startup_rejected(
        &prepared,
        &database_path,
        &wrong_revision_endpoint,
        &prepared.module_id,
        prepared.incarnation_revision + 1,
        OWNER_SEED,
    );

    let invalid_database = temp_dir.path().join("invalid.sqlite");
    fs::write(&invalid_database, b"not a SQLite database").expect("invalid database fixture");
    let startup_failure_endpoint = endpoint(&temp_dir, "startup-failure");
    assert_startup_rejected(
        &prepared,
        &invalid_database,
        &startup_failure_endpoint,
        &prepared.module_id,
        prepared.incarnation_revision,
        OWNER_SEED,
    );
    assert!(!database_path.with_extension("sqlite-wal").exists());
}

#[test]
fn g3_matrix_retains_all_declared_process_controls() {
    let g1 = document(G1_MATRIX, "accepted G1");
    let g2 = document(G2_MATRIX, "accepted G2");
    let g3 = document(G3_MATRIX, "G3");
    assert_eq!(
        g3["source_boundary"]["handoff"],
        "accepted G2 invocation context to one daemon-supervised local operational premise"
    );
    assert_eq!(
        g3["source_boundary"]["effect_boundary"],
        "before external I/O"
    );
    for id in [
        "G3-OPERABLE-LOCAL-001",
        "G3-CONTROL-CONFIG-RESTART-001",
        "G3-CONTROL-SECRET-UNRESOLVED-001",
        "G3-CONTROL-SECRET-DISCLOSURE-001",
        "G3-CONTROL-EXTERNAL-IO-001",
        "G3-CONTROL-OBSERVABILITY-001",
        "G3-CONTROL-RESTORE-SCOPE-001",
    ] {
        let g3_case = case(&g3, id, "G3");
        assert_eq!(g3_case["expected"], "pass");
    }
    assert_eq!(case(&g1, "G1-EXEC-001", "G1")["expected"], "product_red");
    assert_eq!(
        case(&g2, "G2-ADMISSION-001", "G2")["expected"],
        "product_red"
    );
}

fn document(source: &str, label: &str) -> Value {
    serde_json::from_str(source)
        .unwrap_or_else(|error| panic!("{label} fixture must be valid JSON: {error}"))
}

fn case<'a>(document: &'a Value, id: &str, label: &str) -> &'a Value {
    document["cases"]
        .as_array()
        .unwrap_or_else(|| panic!("{label} matrix cases must be an array"))
        .iter()
        .find(|candidate| candidate["id"] == id)
        .unwrap_or_else(|| panic!("{label} matrix case {id} is missing"))
}
