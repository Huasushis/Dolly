use dolly_canonical_json::Sha256Digest;
use dolly_core_domain::LeaseToken;
use dolly_core_reducer::{
    BuildManifestCommand, CoreSnapshot, EnvironmentInput, InstanceMode,
};
use dolly_extension_host::{
    admit_operational_activation_components, ConfigurationStore, MODULE_ACTIVATE_METHOD,
};
use dolly_protocol::FrameLimits;
use dolly_runtime::{
    activation_stage_allocation, activation_stage_dispatch, activation_stage_lease,
    activation_stage_manifest, LeaseRequest,
};
use dolly_storage::{
    ActivationTransaction, HostCapabilityGrant, HostConnectionAuthority, SqliteCoreStore,
};
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
    if validate_request_against_grant(connection, launch, &request).is_err() {
        return ControlResponse::rejected("request_fence_mismatch");
    }
    if activation_barrier("PREFLIGHT").is_err() {
        return ControlResponse::rejected("activation_rejected");
    }
    // The whole request runs in one immediate SQLite transaction: grant/Host
    // validation, manifest acceptance, request allocation, lease issue,
    // dispatch journal, and G2 admission. Commit happens only after admission
    // succeeds, so any failure or daemon kill rolls back every request-owned
    // row and never leaves a partial activation.
    let mut activation = match ActivationTransaction::begin(connection) {
        Ok(transaction) => transaction,
        Err(_) => return ControlResponse::rejected("activation_rejected"),
    };
    let authority = match activation.authority() {
        Ok(authority) => authority,
        Err(_) => return ControlResponse::rejected("activation_rejected"),
    };
    let grant = match activation
        .current_grant(&authority, &launch.extension_id, &request.module_id)
    {
        Ok(grant) => grant,
        Err(_) => return ControlResponse::rejected("activation_rejected"),
    };
    let snapshot = match activation.snapshot() {
        Ok(snapshot) => snapshot,
        Err(_) => return ControlResponse::rejected("activation_rejected"),
    };
    if !grant_matches(&authority, grant.as_ref(), &snapshot, launch, &request) {
        // The durable grant does not match the request, or a concurrent
        // replace/revoke committed before this transaction. Dropping the
        // transaction rolls back every request-owned row.
        return ControlResponse::rejected("request_fence_mismatch");
    }
    if activation_barrier("GRANT").is_err() {
        return ControlResponse::rejected("activation_rejected");
    }
    let lease_token = match request.lease_token.parse::<LeaseToken>() {
        Ok(token) => token,
        Err(_) => return ControlResponse::rejected("activation_rejected"),
    };
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
        request.lease_id.clone(),
        token_digest,
        Some(request.extension_generation),
    );
    let outcome = (|| -> Result<(String, i64), ()> {
        activation_stage_manifest(&mut activation, &build, &input).map_err(|_| ())?;
        if activation_barrier("MANIFEST").is_err() {
            return Err(());
        }
        let reservation = activation_stage_allocation(
            &mut activation,
            &authority,
            &request.activation_id,
            &request.lease_id,
            &input,
        )
        .map_err(|_| ())?;
        let (premise, _) =
            activation_stage_lease(&mut activation, &lease, &reservation, &input)
                .map_err(|_| ())?;
        if activation_barrier("LEASE").is_err() {
            return Err(());
        }
        let dispatch = activation_stage_dispatch(
            &mut activation,
            &premise,
            "dolly-local-daemon-dispatch",
            &lease_token,
            &input,
        )
        .map_err(|_| ())?;
        if activation_barrier("DISPATCH").is_err() {
            return Err(());
        }
        let operational = admit_operational_activation_components(
            &premise,
            &dispatch,
            FrameLimits::defaults(),
            &authority,
            grant.as_ref(),
        )
        .map_err(|_| ())?;
        if operational.invocation().module_id() != launch.module_id
            || operational.invocation().extension_id() != Some(launch.extension_id.as_str())
        {
            return Err(());
        }
        if activation_barrier("ADMIT").is_err() {
            return Err(());
        }
        let durable_commit_seq = dispatch
            .transition()
            .events
            .last()
            .map(|event| event.commit_seq)
            .ok_or(())?;
        Ok((dispatch.frame_digest().to_owned(), durable_commit_seq))
    })();
    match outcome {
        Ok((frame_digest, durable_commit_seq)) => {
            if activation.commit().is_err() {
                return ControlResponse::rejected("activation_rejected");
            }
            ControlResponse {
                accepted: true,
                code: "activation_dispatched",
                activation_id: Some(request.activation_id),
                frame_digest: Some(frame_digest),
                durable_commit_seq: Some(durable_commit_seq),
            }
        }
        Err(()) => ControlResponse::rejected("activation_rejected"),
    }
}

/// Deterministic test barrier. When `DOLLY_ACTIVATION_BARRIER_<key>` names a
/// path, bind a Unix socket there, wait for one peer connection, and block
/// until the peer closes. Production launches never set the variable.
fn activation_barrier(key: &str) -> Result<(), ()> {
    let Some(path) = std::env::var_os(format!("DOLLY_ACTIVATION_BARRIER_{key}")) else {
        return Ok(());
    };
    let path = PathBuf::from(path);
    let _ = fs::remove_file(&path);
    let listener = UnixListener::bind(&path).map_err(|_| ())?;
    let (mut stream, _) = listener.accept().map_err(|_| ())?;
    let mut token = [0u8; 1];
    let _ = stream.read(&mut token);
    drop(listener);
    let _ = fs::remove_file(&path);
    Ok(())
}

/// Earlier fast-path grant check. The authoritative grant/Host/premise
/// validation repeats inside the single activation transaction, atomically
/// with the first request-owned write, so no separate durable fence is
/// needed.
fn validate_request_against_grant(
    connection: &mut Connection,
    launch: &LaunchConfiguration,
    request: &ControlRequest,
) -> Result<(), ()> {
    let (authority, grant, snapshot) = {
        let store = SqliteCoreStore::new(connection).map_err(|_| ())?;
        let authority = store.authenticated_host_connection().map_err(|_| ())?;
        let grant = store
            .current_host_capability_grant(&authority, &launch.extension_id, &request.module_id)
            .map_err(|_| ())?;
        let snapshot = store.snapshot().map_err(|_| ())?;
        (authority, grant, snapshot)
    };
    if grant_matches(&authority, grant.as_ref(), &snapshot, launch, request) {
        Ok(())
    } else {
        Err(())
    }
}

/// Compare the exact request fields against the current durable Host grant,
/// Host authority, and installed graph, mirroring every request-controlled
/// check the operational admission performs.
fn grant_matches(
    authority: &HostConnectionAuthority,
    grant: Option<&HostCapabilityGrant>,
    snapshot: &CoreSnapshot,
    launch: &LaunchConfiguration,
    request: &ControlRequest,
) -> bool {
    let Some(grant) = grant else {
        return false;
    };
    if request.extension_generation != grant.extension_generation()
        || u64::try_from(request.extension_generation).ok() != Some(launch.generation)
        || request.module_id != grant.module_id()
        || launch.control_channel_id != grant.extension_connection_id()
        || launch.worker_epoch != grant.worker_epoch()
        || launch.worker_epoch_fence != grant.worker_epoch_fence()
        || launch.incarnation_revision != grant.incarnation_revision()
        || authority.extension_connection_id() != launch.control_channel_id
        || authority.worker_epoch_fence() != launch.worker_epoch_fence
        || authority.incarnation_revision() != launch.incarnation_revision
    {
        return false;
    }
    let manifest = &request.manifest;
    if manifest.get("descriptor_revision").and_then(Value::as_i64)
        != Some(grant.descriptor_revision())
        || manifest.get("config_revision").and_then(Value::as_i64)
            != Some(grant.manifest_revision())
        || manifest.get("graph_revision").and_then(Value::as_i64) != Some(grant.graph_revision())
        || manifest.get("manifest_digest").and_then(Value::as_str) != Some(grant.manifest_digest())
    {
        return false;
    }
    let graph_digest = snapshot.graph.get("digest").and_then(Value::as_str);
    let descriptor_digest = snapshot
        .graph
        .get("graph")
        .and_then(|graph| graph.get("descriptors"))
        .and_then(Value::as_object)
        .and_then(|descriptors| descriptors.get(&request.module_id))
        .and_then(|entry| entry.get("source_descriptor_digest"))
        .and_then(Value::as_str);
    graph_digest == Some(grant.graph_digest())
        && descriptor_digest == Some(grant.descriptor_digest())
}
