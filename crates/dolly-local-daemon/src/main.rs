use dolly_canonical_json::Sha256Digest;
use dolly_core_domain::LeaseToken;
use dolly_core_reducer::{
    ActivationState, BuildManifestCommand, CoreSnapshot, EnvironmentInput, InstanceMode,
    TransitionOutcome,
};
use dolly_extension_host::{
    admit_operational_activation, ConfigurationStore, MODULE_ACTIVATE_METHOD,
};
use dolly_protocol::FrameLimits;
use dolly_runtime::{LeaseRequest, RuntimeTransactionEngine};
use dolly_storage::SqliteCoreStore;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::FileTypeExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

const MAX_CONTROL_REQUEST_BYTES: usize = 64 * 1024;
const DAEMON_READY_LINE: &str = "DOLLY_DAEMON_READY_V1";

#[derive(Debug)]
struct LaunchConfiguration {
    database_path: PathBuf,
    endpoint: PathBuf,
    extension_id: String,
    module_id: String,
    owner_seed: String,
    generation: u64,
    worker_epoch: String,
    control_channel_id: String,
    owner_token: String,
    worker_epoch_fence: i64,
    incarnation_revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlRequest {
    operation: String,
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

#[derive(Debug, Serialize)]
struct ControlResponse {
    accepted: bool,
    code: &'static str,
    activation_id: Option<String>,
    frame_digest: Option<String>,
    durable_commit_seq: Option<i64>,
}

impl ControlResponse {
    fn rejected(code: &'static str) -> Self {
        Self {
            accepted: false,
            code,
            activation_id: None,
            frame_digest: None,
            durable_commit_seq: None,
        }
    }
}

struct SocketCleanup {
    path: PathBuf,
}

impl Drop for SocketCleanup {
    fn drop(&mut self) {
        if fs::symlink_metadata(&self.path)
            .map(|metadata| metadata.file_type().is_socket())
            .unwrap_or(false)
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn main() {
    if let Err(reason) = run() {
        eprintln!("dolly local daemon startup failed: {reason}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), &'static str> {
    let launch = LaunchConfiguration::from_environment().map_err(|_| "invalid_launch_identity")?;
    let mut connection = Connection::open(&launch.database_path).map_err(|_| "database_open")?;
    validate_production_state(&mut connection, &launch)?;

    if launch.endpoint.as_os_str().is_empty() {
        return Err("invalid_control_endpoint");
    }
    let listener = bind_control_endpoint(&launch.endpoint)?;
    let _cleanup = SocketCleanup {
        path: launch.endpoint.clone(),
    };

    println!(
        "{DAEMON_READY_LINE} {} {} {} {} 1",
        launch.generation, launch.worker_epoch, launch.control_channel_id, launch.owner_token,
    );
    std::io::stdout().flush().map_err(|_| "readiness_output")?;

    for incoming in listener.incoming() {
        let Ok(mut stream) = incoming else {
            return Err("control_endpoint_accept");
        };
        let response = match read_request(&mut stream) {
            Ok(request) => process_request(&mut connection, &launch, request),
            Err(code) => ControlResponse::rejected(code),
        };
        write_response(&mut stream, response).map_err(|_| "control_response_write")?;
    }
    Ok(())
}

fn bind_control_endpoint(path: &Path) -> Result<UnixListener, &'static str> {
    if UnixStream::connect(path).is_ok() {
        return Err("control_endpoint_active");
    }
    if path.exists() {
        let metadata = fs::symlink_metadata(path).map_err(|_| "control_endpoint_metadata")?;
        if !metadata.file_type().is_socket() {
            return Err("control_endpoint_not_socket");
        }
        fs::remove_file(path).map_err(|_| "control_endpoint_cleanup")?;
    }
    UnixListener::bind(path).map_err(|_| "control_endpoint_bind")
}

impl LaunchConfiguration {
    fn from_environment() -> Result<Self, ()> {
        let database_path = required_path("DOLLY_DATABASE_PATH")?;
        let endpoint = required_path("DOLLY_CONTROL_ENDPOINT")?;
        let extension_id = required("DOLLY_EXTENSION_ID")?;
        let module_id = required("DOLLY_MODULE_ID")?;
        let owner_seed = required("DOLLY_OWNER_SEED")?;
        let generation = required("DOLLY_DAEMON_GENERATION")?
            .parse()
            .map_err(|_| ())?;
        let worker_epoch = required("DOLLY_DAEMON_WORKER_EPOCH")?;
        let control_channel_id = required("DOLLY_DAEMON_CONTROL_CHANNEL_ID")?;
        let owner_token = required("DOLLY_DAEMON_OWNER_TOKEN")?;
        let worker_epoch_fence = required("DOLLY_WORKER_EPOCH_FENCE")?
            .parse()
            .map_err(|_| ())?;
        let incarnation_revision = required("DOLLY_INCARNATION_REVISION")?
            .parse()
            .map_err(|_| ())?;
        if generation == 0 || worker_epoch_fence <= 0 || incarnation_revision <= 0 {
            return Err(());
        }
        if required("DOLLY_DAEMON_STORAGE_READY")? != "1" {
            return Err(());
        }
        let expected_owner_token =
            Sha256Digest::compute(format!("{owner_seed}:{generation}").as_bytes())
                .to_canonical_string();
        if expected_owner_token != owner_token {
            return Err(());
        }
        Ok(Self {
            database_path,
            endpoint,
            extension_id,
            module_id,
            owner_seed,
            generation,
            worker_epoch,
            control_channel_id,
            owner_token,
            worker_epoch_fence,
            incarnation_revision,
        })
    }
}

fn required(name: &str) -> Result<String, ()> {
    let value = std::env::var(name).map_err(|_| ())?;
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return Err(());
    }
    Ok(value)
}

fn required_path(name: &str) -> Result<PathBuf, ()> {
    let value = std::env::var_os(name).ok_or(())?;
    if value.is_empty() {
        return Err(());
    }
    Ok(PathBuf::from(value))
}

fn validate_production_state(
    connection: &mut Connection,
    launch: &LaunchConfiguration,
) -> Result<(), &'static str> {
    let (snapshot, authority, grant_present) = {
        let store = SqliteCoreStore::new(connection).map_err(|_| "storage_schema")?;
        let snapshot = store.snapshot().map_err(|_| "storage_snapshot")?;
        let authority = store
            .authenticated_host_connection()
            .map_err(|_| "host_authority")?;
        let grant_present = store
            .current_host_capability_grant(&authority, &launch.extension_id, &launch.module_id)
            .map_err(|_| "capability_grant")?
            .is_some();
        (snapshot, authority, grant_present)
    };
    if snapshot.mode != InstanceMode::Running {
        return Err("storage_not_running");
    }
    if snapshot.host_connection.is_none() {
        return Err("host_state_missing");
    }
    if !grant_present {
        return Err("capability_grant_missing");
    }
    if !graph_contains_module(&snapshot, &launch.module_id) {
        return Err("module_not_in_graph");
    }
    if authority.extension_connection_id() != launch.control_channel_id
        || authority.worker_epoch().to_string() != launch.worker_epoch
        || authority.worker_epoch_fence() != launch.worker_epoch_fence
        || authority.incarnation_revision() != launch.incarnation_revision
    {
        return Err("host_identity_mismatch");
    }
    let _configuration = ConfigurationStore::new(connection).map_err(|_| "configuration_schema")?;
    let _frame_limits = FrameLimits::defaults();
    if MODULE_ACTIVATE_METHOD != "module.activate" || launch.owner_seed.is_empty() {
        return Err("extension_host_not_ready");
    }
    Ok(())
}

fn graph_contains_module(snapshot: &CoreSnapshot, module_id: &str) -> bool {
    snapshot
        .graph
        .get("graph")
        .and_then(|graph| graph.get("descriptors"))
        .and_then(Value::as_object)
        .and_then(|descriptors| descriptors.get(module_id))
        .and_then(|entry| entry.get("value"))
        .and_then(|descriptor| descriptor.get("module_id"))
        .and_then(Value::as_str)
        == Some(module_id)
}

fn read_request(stream: &mut UnixStream) -> Result<ControlRequest, &'static str> {
    let mut bytes = Vec::new();
    stream
        .take((MAX_CONTROL_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "invalid_request")?;
    if bytes.len() > MAX_CONTROL_REQUEST_BYTES {
        return Err("request_too_large");
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid_request")
}

fn write_response(stream: &mut UnixStream, response: ControlResponse) -> Result<(), ()> {
    let mut bytes = serde_json::to_vec(&response).map_err(|_| ())?;
    bytes.push(b'\n');
    stream.write_all(&bytes).map_err(|_| ())
}

fn process_request(
    connection: &mut Connection,
    launch: &LaunchConfiguration,
    request: ControlRequest,
) -> ControlResponse {
    if request.operation != "module.activate"
        || request.generation != launch.generation
        || request.control_channel_id != launch.control_channel_id
        || request.owner_token != launch.owner_token
        || request.module_id != launch.module_id
        || request.activation_id.is_empty()
        || request.lease_id.is_empty()
        || request.extension_generation <= 0
        || request.now.is_empty()
    {
        return ControlResponse::rejected("request_fence_mismatch");
    }
    match perform_activation(connection, launch, request) {
        Ok(response) => response,
        Err(_) => ControlResponse::rejected("activation_rejected"),
    }
}

fn perform_activation(
    connection: &mut Connection,
    launch: &LaunchConfiguration,
    request: ControlRequest,
) -> Result<ControlResponse, ()> {
    let lease_token: LeaseToken = request.lease_token.parse().map_err(|_| ())?;
    let token_digest = Sha256Digest::compute(lease_token.expose_bytes()).to_canonical_string();
    let input = EnvironmentInput {
        now: request.now.clone(),
        graph_revision: Some(1),
        descriptor_revision: Some(1),
        ..EnvironmentInput::default()
    };
    let build = BuildManifestCommand {
        command_id: "dolly-local-daemon-build".to_owned(),
        activation_id: request.activation_id.clone(),
        manifest: request.manifest,
        expected_graph_revision: Some(1),
        expected_descriptor_revision: Some(1),
    };
    let lease = LeaseRequest::new(
        "dolly-local-daemon-lease",
        request.activation_id.clone(),
        request.lease_id,
        token_digest,
        Some(request.extension_generation),
    );
    let mut engine = RuntimeTransactionEngine::new(connection).map_err(|_| ())?;
    let built = engine.accept_manifest(&build, &input).map_err(|_| ())?;
    if built.outcome != TransitionOutcome::Committed {
        return Err(());
    }
    let reservation = engine.allocate_request(&lease, &input).map_err(|_| ())?;
    let premise = engine
        .prepare_execution(&lease, &reservation, &input)
        .map_err(|_| ())?;
    let dispatch = engine
        .dispatch_execution(
            &premise,
            "dolly-local-daemon-dispatch",
            &lease_token,
            &input,
        )
        .map_err(|_| ())?;
    if dispatch.transition().outcome != TransitionOutcome::Committed
        || dispatch
            .transition()
            .state
            .activations
            .get(&request.activation_id)
            .map(|activation| activation.state)
            != Some(ActivationState::Dispatched)
    {
        return Err(());
    }
    let durable_commit_seq = dispatch
        .transition()
        .events
        .last()
        .map(|event| event.commit_seq)
        .ok_or(())?;
    drop(engine);

    let store = SqliteCoreStore::new(connection).map_err(|_| ())?;
    let operational =
        admit_operational_activation(&premise, &dispatch, &store, FrameLimits::defaults())
            .map_err(|_| ())?;
    if operational.invocation().module_id() != launch.module_id
        || operational.invocation().extension_id() != Some(launch.extension_id.as_str())
    {
        return Err(());
    }
    Ok(ControlResponse {
        accepted: true,
        code: "activation_dispatched",
        activation_id: Some(request.activation_id),
        frame_digest: Some(dispatch.frame_digest().to_owned()),
        durable_commit_seq: Some(durable_commit_seq),
    })
}
