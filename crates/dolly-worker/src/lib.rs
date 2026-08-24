use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use dolly_canonical_json::{
    CanonicalJsonObject, CanonicalJsonValue, PROTOCOL_WIRE_PARSE_DEPTH, Sha256Digest, canonicalize,
};
use dolly_core_domain::ExtensionId;
use dolly_storage::Database;
use dolly_storage::effect_journal::{
    EffectJournalInsertDisposition, create_effect_journal_schema, insert_intent,
    settle_pending_effect_journal,
};
use dolly_storage::host_authority::load_current_authority;
use dolly_storage::mcp_readiness::{MCP_PROTOCOL_VERSION_2025_06_18, McpTransportReadiness};
use dolly_storage::runtime_binding::{
    ProcessGeneration, RuntimeBinding, RuntimeBindingError, invalidate_runtime_binding,
    mint_current_runtime_binding,
};
#[cfg(feature = "test-support")]
use dolly_storage::linux_host_verification::VerifiedLinuxHostProof;
#[cfg(feature = "test-support")]
use dolly_storage::runtime_binding::mint_runtime_binding;
use dolly_storage::tool_broker_authority::{
    ToolDispatchAuthority, ToolRegistryRevision, authorize_tool_dispatch, publish_tool_registry,
};
use dolly_storage::tool_ledger::create_tool_ledger_schema;
use dolly_tool_broker::{AdmissionOutcome, LedgerState, RecoveryFacts, ToolCallLedgerRecord};
use dolly_tool_broker::effect_journal::{
    Claim, ClaimRecordSchemaTag, EffectClass, EffectJournalRecordSchemaTag, EffectJournalState,
    ExternalEffectJournalRecord, derive_claim_token,
};
use dolly_tool_coordinator::{
    DispatchError, DispatchLimits, DispatchOutcome,
    HostMcpStdioInstalledChildAttestation, HostMcpStdioInvocation, HostMcpStdioProcessHandle,
    StdioTransportError, StdioTransportLimits, ToolDispatchService,
    dispatch_operation_authorized_reusable,
};
use thiserror::Error;

/// Inputs owned by the Runtime Worker for one installed stdio tool server.
#[derive(Debug, Clone)]
pub struct WorkerStartConfig {
    pub db_path: PathBuf,
    pub extension_alias: ExtensionId,
    pub server_id: String,
    pub package_root: PathBuf,
    pub package_path: PathBuf,
}

/// Fail-closed Worker startup or one-shot dispatch refusal.
#[derive(Debug, Error)]
pub enum WorkerError {
    #[error("Worker startup is unsupported on this platform")]
    UnsupportedPlatform,
    #[error("Worker authority refused: {0}")]
    Authority(String),
    #[error("Worker storage refused: {0}")]
    Storage(String),
    #[error("Worker durable premise refused: {0}")]
    Premise(String),
    #[error("Worker package refused: {0}")]
    Package(String),
    #[error("Worker process refused: {0}")]
    Process(String),
    #[error("Worker MCP transport refused: {0:?}")]
    Transport(StdioTransportError),
    #[error("Worker dispatch refused: {0:?}")]
    Dispatch(DispatchError),
    #[error("Worker session is stopped or already consumed")]
    Stopped,
}

/// One Rust-owned Worker instance. The Worker is the only production owner of
/// the installed child, its initialized MCP session, and coordinator dispatch.
pub struct Worker {
    database: Database,
    runtime_binding: RuntimeBinding,
    process_generation: ProcessGeneration,
    readiness: McpTransportReadiness,
    registry: ToolRegistryRevision,
    dispatch_authority: ToolDispatchAuthority,
    service: ToolDispatchService,
    package_digest: Sha256Digest,
    invocation: Option<HostMcpStdioInvocation>,
    process_handle: HostMcpStdioProcessHandle,
    stopped: bool,
}

impl Worker {
    /// Execute the bounded Linux-first startup sequence and retain one
    /// verified, initialized stdio session for the next tools/call dispatch.
    pub fn start(config: WorkerStartConfig) -> Result<Self, WorkerError> {
        Self::start_internal(config, mint_current_runtime_binding, false)
    }

    /// Test-support constructor: drives the identical production startup
    /// path but mints the runtime binding from an injected, already-verified
    /// Host proof instead of re-observing the live Linux host. Gated to the
    /// `test-support` feature; production builds never expose it.
    #[cfg(feature = "test-support")]
    pub fn start_with_verified_proof(
        config: WorkerStartConfig,
        verified_proof: VerifiedLinuxHostProof,
    ) -> Result<Self, WorkerError> {
        Self::start_internal(
            config,
            move |db, alias| mint_runtime_binding(db, alias, verified_proof),
            true,
        )
    }

    fn start_internal<F>(
        config: WorkerStartConfig,
        mint: F,
        use_test_readiness: bool,
    ) -> Result<Self, WorkerError>
    where
        F: FnOnce(&mut Database, ExtensionId) -> Result<RuntimeBinding, RuntimeBindingError>,
    {
        if !cfg!(target_os = "linux") {
            return Err(WorkerError::UnsupportedPlatform);
        }
        if config.server_id.is_empty() {
            return Err(WorkerError::Premise("server identity is empty".into()));
        }

        let mut database = Database::open(&config.db_path)
            .map_err(|error| WorkerError::Storage(error.to_string()))?;
        let snapshot = load_current_authority(database.connection())
            .map_err(|error| WorkerError::Authority(error.to_string()))?
            .ok_or_else(|| WorkerError::Premise("current Host authority is absent".into()))?;
        let durable_server = load_durable_server(&snapshot, &config.server_id)?;
        let package_root = canonical_directory(&config.package_root)?;
        let package_path = canonical_file(&config.package_path, "package")?;
        let executable_path = package_root.join(&durable_server.endpoint);
        let executable_path = canonical_file(&executable_path, "executable")?;
        if !executable_path.starts_with(&package_root) {
            return Err(WorkerError::Package(
                "stdio executable escapes the installed package root".into(),
            ));
        }
        verify_digest(
            &package_path,
            &durable_server.package_digest,
            "installed package",
        )?;
        verify_digest(
            &executable_path,
            &durable_server.executable_digest,
            "installed executable",
        )?;
        create_tool_ledger_schema(database.connection())
            .map_err(|error| WorkerError::Storage(error.to_string()))?;
        // The Worker is the sole owner of the effect journal: it creates the
        // schema and runs the deterministic reopen recovery seam. Any pending
        // `INTENDED` intent from a previous incarnation is settled only from
        // identity-matched authoritative ledger evidence (or `UNKNOWN_OUTCOME`);
        // nothing is ever re-dispatched (a new attempt requires a new Claim).
        create_effect_journal_schema(database.connection())
            .map_err(|error| WorkerError::Storage(error.to_string()))?;
        settle_pending_effect_journal(&mut database)
            .map_err(|error| WorkerError::Storage(error.to_string()))?;

        let startup_deadline = Instant::now()
            .checked_add(durable_server.startup_timeout)
            .ok_or_else(|| WorkerError::Process("startup deadline overflow".into()))?;
        let session_id = new_session_id()?;
        let mut runtime_binding = mint(&mut database, config.extension_alias.clone())
            .map_err(|error| WorkerError::Authority(error.to_string()))?;
        let process_generation = match runtime_binding.mint_process_generation(&mut database) {
            Ok(generation) => generation,
            Err(error) => {
                return Err(startup_failure(
                    &mut database,
                    &runtime_binding,
                    None,
                    None,
                    WorkerError::Authority(error.to_string()),
                ));
            }
        };

        let mut command = Command::new(&executable_path);
        command
            .args(&durable_server.args)
            .current_dir(&package_root)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return Err(startup_failure(
                    &mut database,
                    &runtime_binding,
                    Some(&process_generation),
                    None,
                    WorkerError::Process(error.to_string()),
                ));
            }
        };
        let attestation = HostMcpStdioInstalledChildAttestation::new(
            config.server_id.clone(),
            "mcp".into(),
            MCP_PROTOCOL_VERSION_2025_06_18.into(),
            "stdio".into(),
            durable_server.endpoint.clone(),
            durable_server.endpoint_digest.clone(),
            durable_server.package_digest.clone(),
            package_path,
            durable_server.executable_digest.clone(),
            executable_path,
            durable_server.transport_digest.clone(),
            runtime_binding.daemon_installation_id().to_owned(),
            runtime_binding.instance_id().to_owned(),
            runtime_binding.controller_generation(),
            runtime_binding.worker_epoch().clone(),
            runtime_binding.extension_alias().clone(),
            process_generation.extension_generation(),
            runtime_binding.binding_digest().clone(),
            session_id,
            child.id(),
        );
        let (mut invocation, process_handle) = match HostMcpStdioInvocation::from_installed_child(
            child,
            attestation,
            &process_generation,
            durable_server.stdio_limits,
            Vec::new(),
        ) {
            Ok(value) => value,
            Err(error) => {
                return Err(startup_failure(
                    &mut database,
                    &runtime_binding,
                    Some(&process_generation),
                    None,
                    WorkerError::Transport(error),
                ));
            }
        };
        let readiness = {
            #[cfg(feature = "test-support")]
            let result = if use_test_readiness {
                invocation.initialize_with_verified_proof(
                    &database,
                    &runtime_binding,
                    &process_generation,
                    &config.server_id,
                    startup_deadline,
                )
            } else {
                invocation.initialize(
                    &database,
                    &runtime_binding,
                    &process_generation,
                    &config.server_id,
                    startup_deadline,
                )
            };
            #[cfg(not(feature = "test-support"))]
            let _ = use_test_readiness;
            #[cfg(not(feature = "test-support"))]
            let result = invocation.initialize(
                &database,
                &runtime_binding,
                &process_generation,
                &config.server_id,
                startup_deadline,
            );
            match result {
                Ok(readiness) => readiness,
                Err(error) => {
                    return Err(startup_failure(
                        &mut database,
                        &runtime_binding,
                        Some(&process_generation),
                        Some(&process_handle),
                        WorkerError::Transport(error),
                    ));
                }
            }
        };
        let registry = match publish_tool_registry(
            &mut database,
            &runtime_binding,
            &process_generation,
            &readiness,
        ) {
            Ok(registry) => registry,
            Err(error) => {
                return Err(startup_failure(
                    &mut database,
                    &runtime_binding,
                    Some(&process_generation),
                    Some(&process_handle),
                    WorkerError::Authority(error.to_string()),
                ));
            }
        };
        let dispatch_authority = match authorize_tool_dispatch(
            &mut database,
            &registry,
            &runtime_binding,
            &process_generation,
            &readiness,
        ) {
            Ok(authority) => authority,
            Err(error) => {
                return Err(startup_failure(
                    &mut database,
                    &runtime_binding,
                    Some(&process_generation),
                    Some(&process_handle),
                    WorkerError::Authority(error.to_string()),
                ));
            }
        };
        let service = ToolDispatchService::new(durable_server.dispatch_limits);
        Ok(Self {
            database,
            runtime_binding,
            process_generation,
            readiness,
            registry,
            dispatch_authority,
            service,
            package_digest: durable_server.package_digest.clone(),
            invocation: Some(invocation),
            process_handle,
            stopped: false,
        })
    }

    pub fn runtime_binding(&self) -> &RuntimeBinding {
        &self.runtime_binding
    }

    pub fn process_generation(&self) -> &ProcessGeneration {
        &self.process_generation
    }

    pub fn readiness(&self) -> &McpTransportReadiness {
        &self.readiness
    }

    pub fn dispatch_authority(&self) -> &ToolDispatchAuthority {
        &self.dispatch_authority
    }

    pub fn process_handle(&self) -> &HostMcpStdioProcessHandle {
        &self.process_handle
    }

    pub fn registry(&self) -> &ToolRegistryRevision {
        &self.registry
    }

    /// Route sequential tools/call rows through the one initialized session.
    /// The retained child is stopped only after explicit stop, terminal
    /// recovery, or a transport/process failure.
    pub fn dispatch_tools_call(
        &mut self,
        row: &ToolCallLedgerRecord,
        facts: &RecoveryFacts,
        request_bytes: &[u8],
    ) -> Result<DispatchOutcome, WorkerError> {
        if self.stopped {
            return Err(WorkerError::Stopped);
        }
        // Durable Claim-bound intent BEFORE any child I/O: the intent is
        // durably recorded, then the child is touched. A persistence failure
        // or an identity collision (the same Claim already recorded) fails the
        // dispatch closed; nothing dispatches on a missing or replayed intent.
        // A settled row never reaches this seam (new attempt requires a new
        // Claim, so an already-settled row cannot be re-dispatched).
        let intent = self.mint_intent_record(row, request_bytes)?;
        match insert_intent(self.database.connection_mut(), &intent) {
            Ok(EffectJournalInsertDisposition::Inserted { .. }) => {}
            Ok(EffectJournalInsertDisposition::Replayed { .. }) => {
                return Err(WorkerError::Premise(
                    "durable intent already recorded for this Claim; refusing a re-dispatch — a new attempt requires a new Claim".into(),
                ));
            }
            Err(error) => return Err(WorkerError::Storage(error.to_string())),
        }
        let invocation = self.invocation.as_mut().ok_or(WorkerError::Stopped)?;
        invocation.set_request_bytes(request_bytes.to_vec());
        let outcome = dispatch_operation_authorized_reusable(
            &mut self.database,
            &self.dispatch_authority,
            &self.runtime_binding,
            &self.process_generation,
            &self.readiness,
            row,
            facts,
            &self.service,
            invocation,
        )
        .map_err(WorkerError::Dispatch);
        let should_stop = match &outcome {
            Err(WorkerError::Dispatch(DispatchError::InvalidRecord)) => false,
            Err(_) => true,
            Ok(DispatchOutcome::Terminalized { record }) => record.state == LedgerState::Unknown,
            Ok(DispatchOutcome::Unchanged { .. }) => true,
            _ => false,
        };
        if should_stop {
            self.stop()?;
        }
        outcome
    }

    /// Mint the exact Claim-bound `INTENDED` intent record for one dispatch.
    ///
    /// The Claim binds the operation identity to this Worker incarnation's
    /// authority context (controller generation, process generation, Worker
    /// epoch, installed package digest, and policy premise). The intent digest
    /// is the digest of the exact request-frame bytes about to be written to
    /// the child. An identity failure fails closed before any child I/O.
    fn mint_intent_record(
        &self,
        row: &ToolCallLedgerRecord,
        request_bytes: &[u8],
    ) -> Result<ExternalEffectJournalRecord, WorkerError> {
        let binding = &row.operation_binding;
        let worker_epoch = self.runtime_binding.worker_epoch().to_string();
        let package_digest = self.package_digest.clone();
        let policy_premise_digest = self.runtime_binding.premises_digest().clone();
        let claim_token = derive_claim_token(
            &binding.instance_id,
            &binding.module_id,
            &binding.operation_id,
            self.runtime_binding.controller_generation().value(),
            self.process_generation.extension_generation().value(),
            &worker_epoch,
            &package_digest,
            &policy_premise_digest,
            EffectClass::McpToolsCall,
        );
        let intent = ExternalEffectJournalRecord {
            schema: EffectJournalRecordSchemaTag,
            journal_revision: 1,
            state: EffectJournalState::Intended,
            claim: Claim {
                schema: ClaimRecordSchemaTag,
                instance_id: binding.instance_id.clone(),
                module_id: binding.module_id.clone(),
                operation_id: binding.operation_id.clone(),
                claim_token,
            },
            controller_generation: self.runtime_binding.controller_generation().value(),
            extension_generation: self.process_generation.extension_generation().value(),
            worker_epoch,
            package_digest,
            policy_premise_digest,
            operation_digest: row.operation_digest.clone(),
            effect_class: EffectClass::McpToolsCall,
            intent_digest: Sha256Digest::compute(request_bytes),
            evidence_digest: None,
        };
        intent
            .verify()
            .map_err(|error| WorkerError::Premise(format!("intent identity invalid: {error}")))?;
        Ok(intent)
    }

    /// Stop and reap the retained child, then invalidate its durable
    /// Runtime/process pointers.
    pub fn stop(&mut self) -> Result<(), WorkerError> {
        if self.stopped {
            return Ok(());
        }
        self.invocation.take();
        self.process_handle.terminate();
        self.stopped = true;
        invalidate_runtime_binding(
            &mut self.database,
            &self.runtime_binding,
            Some(&self.process_generation),
        )
        .map_err(|error| WorkerError::Authority(error.to_string()))
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn startup_failure(
    database: &mut Database,
    runtime_binding: &RuntimeBinding,
    process_generation: Option<&ProcessGeneration>,
    process_handle: Option<&HostMcpStdioProcessHandle>,
    error: WorkerError,
) -> WorkerError {
    if let Some(process_handle) = process_handle {
        process_handle.terminate();
    }
    match invalidate_runtime_binding(database, runtime_binding, process_generation) {
        Ok(()) => error,
        Err(cleanup_error) => WorkerError::Authority(format!(
            "{error}; durable startup cleanup failed: {cleanup_error}"
        )),
    }
}

struct DurableServer {
    endpoint: String,
    args: Vec<String>,
    package_digest: Sha256Digest,
    executable_digest: Sha256Digest,
    transport_digest: Sha256Digest,
    endpoint_digest: Sha256Digest,
    startup_timeout: Duration,
    stdio_limits: StdioTransportLimits,
    dispatch_limits: DispatchLimits,
}

fn load_durable_server(
    snapshot: &dolly_storage::host_authority::CurrentAuthoritySnapshot,
    server_id: &str,
) -> Result<DurableServer, WorkerError> {
    let root = as_object(
        &snapshot.mapping.canonical_config.runtime_config,
        "runtime config",
    )?;
    let spec = as_object(
        required(root, "spec", "runtime config")?,
        "runtime config spec",
    )?;
    let services = as_object(
        required(spec, "services", "runtime config spec")?,
        "runtime services",
    )?;
    let tool_broker = required(services, "tool_broker", "runtime services")?;
    let (tool_broker_bytes, _) = canonicalize(tool_broker).map_err(|error| {
        WorkerError::Premise(format!("tool-broker config is not canonical: {error}"))
    })?;
    let admitted = match dolly_tool_broker::admit_config(tool_broker_bytes.as_ref()) {
        AdmissionOutcome::Admitted(config) => config,
        AdmissionOutcome::Rejected(rejection) => {
            return Err(WorkerError::Premise(format!(
                "tool-broker policy admission failed: {:?}",
                rejection.reason()
            )));
        }
    };
    let server = admitted.servers().get(server_id).ok_or_else(|| {
        WorkerError::Premise(format!("configured MCP server {server_id} is absent"))
    })?;
    if !server.enabled {
        return Err(WorkerError::Premise(format!(
            "configured MCP server {server_id} is disabled"
        )));
    }
    if server.adapter != "mcp"
        || server.protocol_version != MCP_PROTOCOL_VERSION_2025_06_18
        || server.transport_kind != "stdio"
    {
        return Err(WorkerError::Premise(
            "Worker accepts only enabled MCP stdio 2025-06-18 servers".into(),
        ));
    }
    let server_value = CanonicalJsonValue::Object(server.server_contract.clone());
    let server_object = as_object(&server_value, "configured server")?;
    let transport = as_object(
        required(server_object, "transport", "configured server")?,
        "stdio transport",
    )?;
    let kind = string_field(transport, "kind", "stdio transport")?;
    if kind != "stdio" {
        return Err(WorkerError::Premise(
            "configured transport is not stdio".into(),
        ));
    }
    let endpoint = string_field(transport, "executable", "stdio transport")?.to_owned();
    if !safe_relative_member(&endpoint) {
        return Err(WorkerError::Package(
            "configured stdio executable is not a safe relative package member".into(),
        ));
    }
    if let Some(CanonicalJsonValue::Object(bindings)) = transport.get("secret_bindings") {
        if !bindings.is_empty() {
            return Err(WorkerError::Premise(
                "stdio secret bindings require an explicit Host secret provider".into(),
            ));
        }
    }
    let package_digest = parse_digest(string_field(
        transport,
        "package_digest",
        "stdio transport",
    )?)?;
    let executable_digest = parse_digest(string_field(
        transport,
        "executable_digest",
        "stdio transport",
    )?)?;
    let transport_value = CanonicalJsonValue::Object(transport.clone());
    let transport_digest = canonicalize(&transport_value)
        .map_err(|error| WorkerError::Premise(error.to_string()))?
        .1;
    let endpoint_digest = canonicalize(&CanonicalJsonValue::String(endpoint.clone()))
        .map_err(|error| WorkerError::Premise(error.to_string()))?
        .1;
    let args = match required(transport, "args", "stdio transport")? {
        CanonicalJsonValue::Array(values) => values
            .iter()
            .map(|value| match value {
                CanonicalJsonValue::String(value) => Ok(value.clone()),
                _ => Err(WorkerError::Premise(
                    "stdio argument is not a string".into(),
                )),
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(WorkerError::Premise("stdio args is not an array".into())),
    };
    let limits = as_object(
        required(server_object, "limits", "configured server")?,
        "server limits",
    )?;
    let startup_timeout_ms = positive_integer(limits, "startup_timeout_ms", "server limits")?;
    let max_request_bytes = positive_usize(limits, "max_request_bytes", "server limits")?;
    let max_response_bytes = positive_usize(limits, "max_response_bytes", "server limits")?;
    let max_frame_bytes = max_request_bytes.max(max_response_bytes);
    let stdio_limits = StdioTransportLimits::new(max_frame_bytes, PROTOCOL_WIRE_PARSE_DEPTH)
        .map_err(WorkerError::Transport)?;
    let dispatch_limits = DispatchLimits {
        max_response_bytes,
        max_members: 4096,
        max_depth: 64,
    };
    Ok(DurableServer {
        endpoint,
        args,
        package_digest,
        executable_digest,
        transport_digest,
        endpoint_digest,
        startup_timeout: Duration::from_millis(startup_timeout_ms),
        stdio_limits,
        dispatch_limits,
    })
}

fn as_object<'a>(
    value: &'a CanonicalJsonValue,
    label: &str,
) -> Result<&'a CanonicalJsonObject, WorkerError> {
    match value {
        CanonicalJsonValue::Object(object) => Ok(object),
        _ => Err(WorkerError::Premise(format!("{label} is not an object"))),
    }
}

fn required<'a>(
    object: &'a CanonicalJsonObject,
    name: &str,
    label: &str,
) -> Result<&'a CanonicalJsonValue, WorkerError> {
    object
        .get(name)
        .ok_or_else(|| WorkerError::Premise(format!("{label} is missing {name}")))
}

fn string_field<'a>(
    object: &'a CanonicalJsonObject,
    name: &str,
    label: &str,
) -> Result<&'a str, WorkerError> {
    match required(object, name, label)? {
        CanonicalJsonValue::String(value) => Ok(value),
        _ => Err(WorkerError::Premise(format!(
            "{label} field {name} is not a string"
        ))),
    }
}

fn positive_integer(
    object: &CanonicalJsonObject,
    name: &str,
    label: &str,
) -> Result<u64, WorkerError> {
    let value = match required(object, name, label)? {
        CanonicalJsonValue::Number(value) => value.as_f64(),
        _ => {
            return Err(WorkerError::Premise(format!(
                "{label} field {name} is not an integer"
            )));
        }
    };
    if !value.is_finite() || value < 1.0 || value.fract() != 0.0 || value > u64::MAX as f64 {
        return Err(WorkerError::Premise(format!(
            "{label} field {name} is outside bounds"
        )));
    }
    Ok(value as u64)
}

fn positive_usize(
    object: &CanonicalJsonObject,
    name: &str,
    label: &str,
) -> Result<usize, WorkerError> {
    let value = positive_integer(object, name, label)?;
    usize::try_from(value)
        .map_err(|_| WorkerError::Premise(format!("{label} field {name} is too large")))
}

fn parse_digest(value: &str) -> Result<Sha256Digest, WorkerError> {
    value
        .parse()
        .map_err(|error| WorkerError::Premise(format!("invalid SHA-256 digest: {error}")))
}

fn safe_relative_member(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.contains('\\')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn canonical_directory(path: &Path) -> Result<PathBuf, WorkerError> {
    let path = fs::canonicalize(path)
        .map_err(|error| WorkerError::Package(format!("package root is unavailable: {error}")))?;
    if !path.is_dir() {
        return Err(WorkerError::Package(
            "package root is not a directory".into(),
        ));
    }
    Ok(path)
}

fn canonical_file(path: &Path, label: &str) -> Result<PathBuf, WorkerError> {
    let path = fs::canonicalize(path)
        .map_err(|error| WorkerError::Package(format!("{label} is unavailable: {error}")))?;
    if !path.is_file() {
        return Err(WorkerError::Package(format!("{label} is not a file")));
    }
    Ok(path)
}

fn verify_digest(path: &Path, expected: &Sha256Digest, label: &str) -> Result<(), WorkerError> {
    let bytes = fs::read(path)
        .map_err(|error| WorkerError::Package(format!("{label} cannot be read: {error}")))?;
    let actual = Sha256Digest::compute(&bytes);
    if &actual != expected {
        return Err(WorkerError::Package(format!(
            "{label} digest does not match durable policy"
        )));
    }
    Ok(())
}

fn new_session_id() -> Result<String, WorkerError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| WorkerError::Process(format!("session identity unavailable: {error}")))?;
    let mut session_id = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut session_id, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_members_are_relative_and_parent_free() {
        assert!(safe_relative_member("bin/tool"));
        assert!(!safe_relative_member(""));
        assert!(!safe_relative_member("/bin/tool"));
        assert!(!safe_relative_member("bin/../tool"));
        assert!(!safe_relative_member("bin//tool"));
        assert!(!safe_relative_member("bin\\tool"));
    }

    #[test]
    fn package_digest_check_rejects_changed_bytes() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("package.bin");
        fs::write(&path, b"package").expect("package bytes");
        let expected = Sha256Digest::compute(b"different");
        let error = verify_digest(&path, &expected, "installed package").expect_err("mismatch");
        assert!(matches!(error, WorkerError::Package(detail) if detail.contains("digest")));
    }

    #[test]
    fn session_identity_is_bounded_and_nonempty() {
        let session_id = new_session_id().expect("session identity");
        assert_eq!(session_id.len(), 32);
        assert!(session_id.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}
