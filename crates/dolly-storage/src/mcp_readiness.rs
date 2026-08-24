//! Private MCP transport-readiness authority.
//!
//! This module is the boundary between a fresh, proof-bound Host runtime and a
//! later Tool Broker registry. It does not create a registry, a tool-server
//! generation, a dispatch permit, a result, or any process lifecycle fact. A
//! transport probe supplies one observation from the real configured endpoint;
//! this module only verifies that observation against the durable Host premise,
//! the live runtime binding, and the process-generation authority.

use std::fmt;

use dolly_canonical_json::{CanonicalJsonObject, CanonicalJsonValue, Sha256Digest, canonicalize};
use dolly_core_domain::{ExtensionGeneration, ExtensionId, WorkerEpoch};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use thiserror::Error;

use crate::Database;
use crate::host_authority::{CurrentAuthoritySnapshot, HostAuthorityError, load_current_authority};
use crate::linux_host_verification::{
    LinuxHostVerificationError, VerifiedLinuxHostProof, verify_current_linux_host,
};
use crate::runtime_binding::{
    ProcessGeneration, RuntimeBinding, RuntimeBindingError, mint_runtime_binding,
};

/// The only readiness evidence version understood by this private seam.
pub const MCP_TRANSPORT_READINESS_SCHEMA: &str = "dolly.mcp-transport-readiness/v1";
/// The only MCP protocol revision admitted by the frozen v1 Tool Broker.
pub const MCP_PROTOCOL_VERSION_2025_06_18: &str = "2025-06-18";

/// Fail-closed classifications for MCP transport-readiness refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpReadinessCode {
    HostPremiseMissing,
    HostPremiseStale,
    HostProofUnavailable,
    RuntimeBindingMissing,
    RuntimeBindingStale,
    ProcessGenerationMissing,
    ProcessGenerationStale,
    ConfiguredServerMissing,
    ConfiguredServerAmbiguous,
    ConfiguredServerDisabled,
    ConfiguredTransportMissing,
    ConfiguredTransportAmbiguous,
    UnsupportedAdapter,
    UnsupportedTransport,
    UnsupportedProtocolVersion,
    ProbeAbsent,
    ProbeAmbiguous,
    ProbeUnsupported,
    ProbeFailed,
    HandshakeIdentityMismatch,
    HandshakeEndpointMismatch,
    HandshakeProtocolMismatch,
    HandshakeIncomplete,
    HandshakeSessionAbsent,
    HandshakeSessionAmbiguous,
    CanonicalEvidenceInvalid,
}

/// Structured refusal. No partial readiness evidence is returned on error.
#[derive(Debug, Error, PartialEq, Eq)]
#[error("MCP transport readiness refused ({code:?}): {detail}")]
pub struct McpReadinessError {
    pub code: McpReadinessCode,
    pub detail: String,
}

impl McpReadinessError {
    fn refused(code: McpReadinessCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

/// A closed view of one configured MCP transport extracted from the current
/// durable Runtime configuration. Its private fields prevent callers from
/// manufacturing a transport identity that is not loaded from that premise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpTransportBinding {
    server_id: String,
    adapter: String,
    protocol_version: String,
    transport_kind: String,
    endpoint: String,
    transport: CanonicalJsonObject,
    server_digest: Sha256Digest,
    transport_digest: Sha256Digest,
    endpoint_digest: Sha256Digest,
    daemon_installation_id: String,
    instance_id: String,
    config_revision: i64,
    config_digest: Sha256Digest,
    premises_digest: Sha256Digest,
}

impl McpTransportBinding {
    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    pub fn adapter(&self) -> &str {
        &self.adapter
    }

    pub fn protocol_version(&self) -> &str {
        &self.protocol_version
    }

    pub fn transport_kind(&self) -> &str {
        &self.transport_kind
    }

    /// The configured endpoint identity. For stdio this is the immutable
    /// package-relative executable member; for HTTP it is the exact HTTPS URL.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// The complete configured transport object, including package digests,
    /// arguments, credential references, or TLS pins as applicable.
    pub fn transport(&self) -> &CanonicalJsonObject {
        &self.transport
    }

    pub fn server_digest(&self) -> &Sha256Digest {
        &self.server_digest
    }

    pub fn transport_digest(&self) -> &Sha256Digest {
        &self.transport_digest
    }

    pub fn endpoint_digest(&self) -> &Sha256Digest {
        &self.endpoint_digest
    }

    pub fn daemon_installation_id(&self) -> &str {
        &self.daemon_installation_id
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn config_revision(&self) -> i64 {
        self.config_revision
    }

    pub fn config_digest(&self) -> &Sha256Digest {
        &self.config_digest
    }

    pub fn premises_digest(&self) -> &Sha256Digest {
        &self.premises_digest
    }
}

/// The result of a real transport's exact MCP initialize/initialized handshake.
///
/// A production transport adapter implements [`McpTransportProbe`]. Tests may
/// inject this closed observation through a deterministic probe, but this
/// module has no fake transport implementation and performs no network or
/// process I/O itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpHandshakeObservation {
    /// The configured server identity reported by the transport adapter.
    pub server_id: Option<String>,
    /// The adapter identity used for the handshake.
    pub adapter: Option<String>,
    /// The daemon installation authority identity observed by the adapter.
    pub daemon_installation_id: Option<String>,
    /// The Runtime instance authority identity observed by the adapter.
    pub instance_id: Option<String>,
    /// The current controller generation observed by the adapter.
    pub controller_generation: Option<ExtensionGeneration>,
    /// The current worker epoch observed by the adapter.
    pub worker_epoch: Option<WorkerEpoch>,
    /// The extension alias observed by the adapter.
    pub extension_alias: Option<ExtensionId>,
    /// The current extension process generation observed by the adapter.
    pub extension_generation: Option<ExtensionGeneration>,
    /// Digest of the exact runtime binding used by the handshake.
    pub runtime_binding_digest: Option<Sha256Digest>,
    /// The observed transport kind (`stdio` or `streamable_http`).
    pub transport_kind: Option<String>,
    /// The exact endpoint identity observed by the adapter.
    pub endpoint: Option<String>,
    /// Digest of the complete configured transport object used by the adapter.
    pub transport_digest: Option<Sha256Digest>,
    /// Protocol version sent in the initialize request.
    pub initialize_request_protocol_version: Option<String>,
    /// Protocol version selected by the initialize response.
    pub initialize_response_protocol_version: Option<String>,
    /// Whether the exact `notifications/initialized` lifecycle message was sent.
    pub initialized_notification_sent: bool,
    /// Exactly one transport session identity must be observed.
    pub session_ids: Vec<String>,
}

/// Errors reported by a real transport probe before an observation exists.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum McpTransportProbeError {
    #[error("configured transport is absent")]
    Absent,
    #[error("configured transport observation is ambiguous: {0}")]
    Ambiguous(String),
    #[error("configured transport is unsupported: {0}")]
    Unsupported(String),
    #[error("MCP transport handshake failed: {0}")]
    Failed(String),
}

/// The Host-owned seam for a real configured MCP transport adapter.
///
/// Implementations own process/socket/credential I/O and must return an
/// observation of the endpoint they actually contacted. This crate does not
/// provide a fake-only or production transport implementation.
pub trait McpTransportProbe {
    fn observe(
        &mut self,
        binding: &McpTransportBinding,
    ) -> Result<McpHandshakeObservation, McpTransportProbeError>;
}

/// Canonical, immutable private readiness evidence. It is deliberately neither
/// serializable nor cloneable: a later registry may borrow it, but callers
/// cannot reconstruct it from copied fields or alter its canonical bytes.
#[derive(Debug, PartialEq, Eq)]
pub struct McpTransportReadiness {
    record: McpTransportReadinessRecord,
    canonical_bytes: Vec<u8>,
    readiness_digest: Sha256Digest,
}

impl McpTransportReadiness {
    pub fn schema(&self) -> &str {
        &self.record.schema
    }

    pub fn readiness_digest(&self) -> &Sha256Digest {
        &self.readiness_digest
    }

    pub fn canonical_bytes(&self) -> &[u8] {
        &self.canonical_bytes
    }

    pub fn server_id(&self) -> &str {
        &self.record.server_id
    }

    pub fn adapter(&self) -> &str {
        &self.record.adapter
    }

    pub fn protocol_version(&self) -> &str {
        &self.record.protocol_version
    }

    pub fn transport_kind(&self) -> &str {
        &self.record.transport_kind
    }

    pub fn endpoint_digest(&self) -> &Sha256Digest {
        &self.record.endpoint_digest
    }

    pub fn transport_digest(&self) -> &Sha256Digest {
        &self.record.transport_digest
    }

    pub fn server_digest(&self) -> &Sha256Digest {
        &self.record.server_digest
    }

    pub fn session_id_digest(&self) -> &Sha256Digest {
        &self.record.session_id_digest
    }

    pub fn daemon_installation_id(&self) -> &str {
        &self.record.daemon_installation_id
    }

    pub fn instance_id(&self) -> &str {
        &self.record.instance_id
    }

    pub fn config_revision(&self) -> i64 {
        self.record.config_revision
    }

    pub fn config_digest(&self) -> &Sha256Digest {
        &self.record.config_digest
    }

    pub fn premises_digest(&self) -> &Sha256Digest {
        &self.record.premises_digest
    }

    pub fn controller_generation(&self) -> ExtensionGeneration {
        self.record.controller_generation
    }

    pub fn worker_epoch(&self) -> &str {
        &self.record.worker_epoch
    }

    pub fn extension_alias(&self) -> &str {
        &self.record.extension_alias
    }

    pub fn extension_generation(&self) -> ExtensionGeneration {
        self.record.extension_generation
    }

    pub fn binding_digest(&self) -> &Sha256Digest {
        &self.record.binding_digest
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct McpTransportReadinessRecord {
    schema: String,
    daemon_installation_id: String,
    instance_id: String,
    config_revision: i64,
    config_digest: Sha256Digest,
    premises_digest: Sha256Digest,
    controller_generation: ExtensionGeneration,
    worker_epoch: String,
    extension_alias: String,
    extension_generation: ExtensionGeneration,
    binding_digest: Sha256Digest,
    server_id: String,
    server_digest: Sha256Digest,
    adapter: String,
    protocol_version: String,
    transport_kind: String,
    endpoint_digest: Sha256Digest,
    transport_digest: Sha256Digest,
    initialize_request_protocol_version: String,
    initialize_response_protocol_version: String,
    initialized_notification_sent: bool,
    session_id_digest: Sha256Digest,
}

/// Mint private readiness from an already fresh, proof-bound runtime and
/// process generation. The current durable Host premise and all authority
/// rows are reloaded before the probe runs.
pub fn prove_current_mcp_transport_readiness<P>(
    connection: &Connection,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
    server_id: &str,
    probe: &mut P,
) -> Result<McpTransportReadiness, McpReadinessError>
where
    P: McpTransportProbe,
{
    prove_current_mcp_transport_readiness_with_verifier(
        connection,
        runtime_binding,
        process_generation,
        server_id,
        probe,
        verify_current_linux_host,
    )
}

fn prove_current_mcp_transport_readiness_with_verifier<P, F>(
    connection: &Connection,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
    server_id: &str,
    probe: &mut P,
    mut verify_live_host: F,
) -> Result<McpTransportReadiness, McpReadinessError>
where
    P: McpTransportProbe,
    F: FnMut(&Connection) -> Result<VerifiedLinuxHostProof, LinuxHostVerificationError>,
{
    let snapshot = load_current_snapshot(connection)?;
    let binding = load_mcp_transport_binding(&snapshot, server_id)?;
    validate_runtime_process_authority(connection, &snapshot, runtime_binding, process_generation)?;
    let observation = probe.observe(&binding).map_err(map_probe_error)?;
    let handshake = validate_handshake(&binding, runtime_binding, process_generation, observation)?;
    let final_snapshot = load_current_snapshot(connection)?;
    if !same_authority_binding(&snapshot, &final_snapshot) {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HostPremiseStale,
            "Runtime Host premise changed during the MCP handshake",
        ));
    }
    validate_runtime_process_authority(
        connection,
        &final_snapshot,
        runtime_binding,
        process_generation,
    )?;
    let final_host_proof = verify_live_host(connection).map_err(|error| {
        McpReadinessError::refused(McpReadinessCode::HostProofUnavailable, error.to_string())
    })?;
    let proof_snapshot = load_current_snapshot(connection)?;
    if !same_authority_binding(&final_snapshot, &proof_snapshot) {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HostPremiseStale,
            "Runtime Host premise changed during final live Host verification",
        ));
    }
    validate_runtime_process_authority(
        connection,
        &proof_snapshot,
        runtime_binding,
        process_generation,
    )?;
    validate_live_host_proof(
        &proof_snapshot,
        runtime_binding,
        process_generation,
        &final_host_proof,
    )?;
    mint_readiness_record(
        &proof_snapshot,
        runtime_binding,
        process_generation,
        &binding,
        handshake,
    )
}

#[cfg(test)]
pub fn test_prove_current_mcp_transport_readiness<P>(
    connection: &Connection,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
    server_id: &str,
    probe: &mut P,
) -> Result<McpTransportReadiness, McpReadinessError>
where
    P: McpTransportProbe,
{
    prove_current_mcp_transport_readiness_with_verifier(
        connection,
        runtime_binding,
        process_generation,
        server_id,
        probe,
        |connection| {
            let snapshot = load_current_authority(connection)
                .expect("test authority schema")
                .expect("test current authority");
            Ok(crate::linux_host_verification::test_proof_for_authority(
                &snapshot,
            ))
        },
    )
}
/// Full producer seam. It consumes the private live Linux Host proof, mints a
/// fresh runtime binding and process generation, and only then admits the real
/// MCP transport handshake as private readiness evidence.
pub fn mint_current_mcp_transport_readiness<P>(
    db: &mut Database,
    extension_alias: ExtensionId,
    server_id: &str,
    probe: &mut P,
) -> Result<McpTransportReadiness, McpReadinessError>
where
    P: McpTransportProbe,
{
    let host_proof = verify_current_linux_host(db.connection()).map_err(|error| {
        McpReadinessError::refused(McpReadinessCode::HostProofUnavailable, error.to_string())
    })?;
    let mut runtime_binding =
        mint_runtime_binding(db, extension_alias, host_proof).map_err(map_runtime_binding_error)?;
    let process_generation = runtime_binding
        .mint_process_generation(db)
        .map_err(map_runtime_binding_error)?;
    prove_current_mcp_transport_readiness(
        db.connection(),
        &runtime_binding,
        &process_generation,
        server_id,
        probe,
    )
}

fn same_authority_binding(
    initial: &CurrentAuthoritySnapshot,
    final_snapshot: &CurrentAuthoritySnapshot,
) -> bool {
    initial.mapping.daemon_installation_id == final_snapshot.mapping.daemon_installation_id
        && initial.mapping.instance_id == final_snapshot.mapping.instance_id
        && initial.mapping.config_revision == final_snapshot.mapping.config_revision
        && initial.mapping.config_digest == final_snapshot.mapping.config_digest
        && match (&initial.premise, &final_snapshot.premise) {
            (Some(initial), Some(final_premise)) => {
                initial.premises_digest == final_premise.premises_digest
                    && initial.service_candidate.candidate_digest
                        == final_premise.service_candidate.candidate_digest
            }
            _ => false,
        }
}
fn validate_live_host_proof(
    snapshot: &CurrentAuthoritySnapshot,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
    proof: &VerifiedLinuxHostProof,
) -> Result<(), McpReadinessError> {
    let premise = snapshot.premise.as_ref().ok_or_else(|| {
        McpReadinessError::refused(
            McpReadinessCode::HostPremiseMissing,
            "final live Host proof has no current durable premise",
        )
    })?;
    let identity_matches = proof.schema()
        == crate::linux_host_verification::LINUX_HOST_VERIFICATION_PROOF_SCHEMA
        && proof.daemon_installation_id() == snapshot.mapping.daemon_installation_id
        && proof.instance_id() == snapshot.mapping.instance_id
        && proof.config_revision() == snapshot.mapping.config_revision
        && proof.config_digest() == &snapshot.mapping.config_digest
        && proof.premises_digest() == &premise.premises_digest
        && proof.service_candidate_digest() == &premise.service_candidate.candidate_digest
        && proof.service_candidate_origin() == &premise.service_candidate.origin
        && proof.daemon_installation_id() == runtime_binding.daemon_installation_id()
        && proof.instance_id() == runtime_binding.instance_id()
        && proof.config_revision() == runtime_binding.config_revision()
        && proof.config_digest() == runtime_binding.config_digest()
        && proof.premises_digest() == runtime_binding.premises_digest()
        && proof.service_candidate_digest() == runtime_binding.service_candidate_digest()
        && proof.service_candidate_origin() == runtime_binding.service_candidate_origin()
        && proof.service() == runtime_binding.service()
        && proof.delegated_root() == runtime_binding.delegated_root()
        && proof.daemon_installation_id() == process_generation.daemon_installation_id()
        && proof.instance_id() == process_generation.instance_id()
        && proof.config_revision() == process_generation.config_revision()
        && proof.config_digest() == process_generation.config_digest()
        && proof.service() == process_generation.service()
        && proof.delegated_root() == process_generation.delegated_root();
    if !identity_matches {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HostPremiseStale,
            "final live Host proof is not the exact proof bound to the current RuntimeBinding and ProcessGeneration",
        ));
    }
    Ok(())
}

struct ValidatedHandshake {
    initialize_request_protocol_version: String,
    initialize_response_protocol_version: String,
    initialized_notification_sent: bool,
    session_id_digest: Sha256Digest,
}

fn load_current_snapshot(
    connection: &Connection,
) -> Result<CurrentAuthoritySnapshot, McpReadinessError> {
    load_current_authority(connection)
        .map_err(map_host_authority_error)?
        .ok_or_else(|| {
            McpReadinessError::refused(
                McpReadinessCode::HostPremiseMissing,
                "current Runtime authority has no committed Host premise",
            )
        })
}

fn load_mcp_transport_binding(
    snapshot: &CurrentAuthoritySnapshot,
    server_id: &str,
) -> Result<McpTransportBinding, McpReadinessError> {
    if server_id.is_empty() {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ConfiguredServerMissing,
            "MCP server identity is empty",
        ));
    }
    let root = as_object(
        &snapshot.mapping.canonical_config.runtime_config,
        "runtime config",
    )?;
    let spec = object_field(root, "spec", "runtime config")?;
    let spec = as_object(spec, "runtime config spec")?;
    let services = object_field(spec, "services", "runtime config spec")?;
    let services = as_object(services, "runtime services")?;
    let tool_broker = object_field(services, "tool_broker", "runtime services")?;
    let tool_broker = as_object(tool_broker, "tool-broker config")?;
    let servers = object_field(tool_broker, "servers", "tool-broker config")?;
    let servers = as_object(servers, "tool-broker servers")?;
    let server = servers.get(server_id).ok_or_else(|| {
        McpReadinessError::refused(
            McpReadinessCode::ConfiguredServerMissing,
            format!("configured MCP server {server_id} is absent"),
        )
    })?;
    let server = as_object(server, "configured MCP server")?;
    let enabled = bool_field(server, "enabled", "configured MCP server")?;
    if !enabled {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ConfiguredServerDisabled,
            format!("configured MCP server {server_id} is disabled"),
        ));
    }
    let adapter = string_field(server, "adapter", "configured MCP server")?;
    if adapter != "mcp" {
        return Err(McpReadinessError::refused(
            McpReadinessCode::UnsupportedAdapter,
            format!("configured adapter {adapter} is not mcp"),
        ));
    }
    let protocol_version = string_field(server, "protocol_version", "configured MCP server")?;
    if protocol_version != MCP_PROTOCOL_VERSION_2025_06_18 {
        return Err(McpReadinessError::refused(
            McpReadinessCode::UnsupportedProtocolVersion,
            format!(
                "configured protocol version {protocol_version} is not {MCP_PROTOCOL_VERSION_2025_06_18}"
            ),
        ));
    }
    let transport_value = server.get("transport").ok_or_else(|| {
        McpReadinessError::refused(
            McpReadinessCode::ConfiguredTransportMissing,
            format!("configured MCP server {server_id} has no transport"),
        )
    })?;
    let transport = as_object(transport_value, "configured MCP transport")?;
    let transport_kind = string_field(transport, "kind", "configured MCP transport")?;
    let endpoint = match transport_kind.as_str() {
        "stdio" => {
            let executable = string_field(transport, "executable", "stdio transport")?;
            if executable.is_empty() || executable.contains("..") {
                return Err(McpReadinessError::refused(
                    McpReadinessCode::UnsupportedTransport,
                    "stdio executable is not a safe relative package member",
                ));
            }
            for field in [
                "package_id",
                "package_version",
                "package_digest",
                "executable_digest",
            ] {
                let value = string_field(transport, field, "stdio transport")?;
                if value.is_empty() {
                    return Err(McpReadinessError::refused(
                        McpReadinessCode::ConfiguredTransportMissing,
                        format!("stdio transport field {field} is empty"),
                    ));
                }
            }
            executable
        }
        "streamable_http" => {
            let endpoint = string_field(transport, "endpoint", "HTTP transport")?;
            let authority = endpoint.strip_prefix("https://").unwrap_or("");
            if authority.is_empty()
                || endpoint.contains('?')
                || endpoint.contains('#')
                || authority.contains('@')
            {
                return Err(McpReadinessError::refused(
                    McpReadinessCode::UnsupportedTransport,
                    "streamable HTTP endpoint must be an HTTPS origin without userinfo, query, or fragment",
                ));
            }
            endpoint
        }
        other => {
            return Err(McpReadinessError::refused(
                McpReadinessCode::UnsupportedTransport,
                format!("unsupported MCP transport kind {other}"),
            ));
        }
    };
    let server_digest = digest_value(
        &CanonicalJsonValue::Object(server.clone()),
        "configured MCP server",
    )?;
    let transport_value = CanonicalJsonValue::Object(transport.clone());
    let transport_digest = digest_value(&transport_value, "configured MCP transport")?;
    let endpoint_digest = digest_value(
        &CanonicalJsonValue::String(endpoint.clone()),
        "configured MCP endpoint",
    )?;
    let premise = snapshot.premise.as_ref().ok_or_else(|| {
        McpReadinessError::refused(
            McpReadinessCode::HostPremiseMissing,
            "current Runtime authority has no complete Host premise",
        )
    })?;
    Ok(McpTransportBinding {
        server_id: server_id.to_string(),
        adapter,
        protocol_version,
        transport_kind,
        endpoint,
        transport: transport.clone(),
        server_digest,
        transport_digest,
        endpoint_digest,
        daemon_installation_id: snapshot.mapping.daemon_installation_id.clone(),
        instance_id: snapshot.mapping.instance_id.clone(),
        config_revision: snapshot.mapping.config_revision,
        config_digest: snapshot.mapping.config_digest.clone(),
        premises_digest: premise.premises_digest.clone(),
    })
}

fn validate_handshake(
    binding: &McpTransportBinding,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
    observation: McpHandshakeObservation,
) -> Result<ValidatedHandshake, McpReadinessError> {
    let Some(adapter) = observation.adapter else {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ProbeAbsent,
            "transport probe did not identify an adapter",
        ));
    };
    if adapter != binding.adapter {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HandshakeIdentityMismatch,
            format!(
                "observed adapter {adapter} differs from {}",
                binding.adapter
            ),
        ));
    }
    let Some(daemon_installation_id) = observation.daemon_installation_id else {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ProbeAbsent,
            "transport probe did not identify the daemon installation",
        ));
    };
    let Some(instance_id) = observation.instance_id else {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ProbeAbsent,
            "transport probe did not identify the Runtime instance",
        ));
    };
    let Some(controller_generation) = observation.controller_generation else {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ProbeAbsent,
            "transport probe did not identify the controller generation",
        ));
    };
    let Some(worker_epoch) = observation.worker_epoch else {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ProbeAbsent,
            "transport probe did not identify the WorkerEpoch",
        ));
    };
    let Some(extension_alias) = observation.extension_alias else {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ProbeAbsent,
            "transport probe did not identify the extension alias",
        ));
    };
    let Some(extension_generation) = observation.extension_generation else {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ProbeAbsent,
            "transport probe did not identify the ExtensionGeneration",
        ));
    };
    let Some(runtime_binding_digest) = observation.runtime_binding_digest else {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ProbeAbsent,
            "transport probe did not identify the runtime binding",
        ));
    };
    if daemon_installation_id != runtime_binding.daemon_installation_id()
        || instance_id != runtime_binding.instance_id()
        || controller_generation != runtime_binding.controller_generation()
        || worker_epoch != *runtime_binding.worker_epoch()
        || extension_alias != *runtime_binding.extension_alias()
        || extension_generation != process_generation.extension_generation()
        || runtime_binding_digest != *runtime_binding.binding_digest()
    {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HandshakeIdentityMismatch,
            "observed transport session is not bound to the current RuntimeBinding and ProcessGeneration",
        ));
    }
    let Some(server_id) = observation.server_id else {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ProbeAbsent,
            "transport probe did not identify a server",
        ));
    };
    if server_id != binding.server_id {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HandshakeIdentityMismatch,
            format!(
                "observed server {server_id} differs from {}",
                binding.server_id
            ),
        ));
    }
    let Some(transport_kind) = observation.transport_kind else {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ProbeAbsent,
            "transport probe did not identify a transport",
        ));
    };
    if transport_kind != binding.transport_kind {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HandshakeIdentityMismatch,
            format!(
                "observed transport {transport_kind} differs from {}",
                binding.transport_kind
            ),
        ));
    }
    let Some(endpoint) = observation.endpoint else {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ProbeAbsent,
            "transport probe did not identify an endpoint",
        ));
    };
    if endpoint != binding.endpoint {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HandshakeEndpointMismatch,
            "observed endpoint differs from the configured endpoint",
        ));
    }
    let Some(transport_digest) = observation.transport_digest else {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ProbeAbsent,
            "transport probe did not provide a complete transport identity",
        ));
    };
    if transport_digest != binding.transport_digest {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HandshakeEndpointMismatch,
            "observed transport identity differs from the complete configured transport",
        ));
    }
    let Some(request_version) = observation.initialize_request_protocol_version else {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HandshakeProtocolMismatch,
            "initialize request did not name a protocol version",
        ));
    };
    let Some(response_version) = observation.initialize_response_protocol_version else {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HandshakeProtocolMismatch,
            "initialize response did not select a protocol version",
        ));
    };
    if request_version != MCP_PROTOCOL_VERSION_2025_06_18
        || response_version != MCP_PROTOCOL_VERSION_2025_06_18
        || request_version != response_version
    {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HandshakeProtocolMismatch,
            format!(
                "MCP initialize lifecycle must use {} exactly",
                MCP_PROTOCOL_VERSION_2025_06_18
            ),
        ));
    }
    if !observation.initialized_notification_sent {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HandshakeIncomplete,
            "notifications/initialized was not observed after initialize",
        ));
    }
    if observation.session_ids.is_empty() {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HandshakeSessionAbsent,
            "transport handshake produced no session identity",
        ));
    }
    if observation.session_ids.len() != 1 {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HandshakeSessionAmbiguous,
            "transport handshake produced multiple session identities",
        ));
    }
    let session_id = &observation.session_ids[0];
    if session_id.is_empty() || session_id.len() > 512 {
        return Err(McpReadinessError::refused(
            McpReadinessCode::HandshakeSessionAbsent,
            "transport session identity is empty or oversized",
        ));
    }
    let session_id_digest = digest_value(
        &CanonicalJsonValue::String(session_id.clone()),
        "transport session identity",
    )?;
    Ok(ValidatedHandshake {
        initialize_request_protocol_version: request_version,
        initialize_response_protocol_version: response_version,
        initialized_notification_sent: observation.initialized_notification_sent,
        session_id_digest,
    })
}

fn mint_readiness_record(
    snapshot: &CurrentAuthoritySnapshot,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
    binding: &McpTransportBinding,
    handshake: ValidatedHandshake,
) -> Result<McpTransportReadiness, McpReadinessError> {
    let record = McpTransportReadinessRecord {
        schema: MCP_TRANSPORT_READINESS_SCHEMA.to_string(),
        daemon_installation_id: snapshot.mapping.daemon_installation_id.clone(),
        instance_id: snapshot.mapping.instance_id.clone(),
        config_revision: snapshot.mapping.config_revision,
        config_digest: snapshot.mapping.config_digest.clone(),
        premises_digest: binding.premises_digest.clone(),
        controller_generation: runtime_binding.controller_generation(),
        worker_epoch: runtime_binding.worker_epoch().to_string(),
        extension_alias: runtime_binding.extension_alias().to_string(),
        extension_generation: process_generation.extension_generation(),
        binding_digest: runtime_binding.binding_digest().clone(),
        server_id: binding.server_id.clone(),
        server_digest: binding.server_digest.clone(),
        adapter: binding.adapter.clone(),
        protocol_version: binding.protocol_version.clone(),
        transport_kind: binding.transport_kind.clone(),
        endpoint_digest: binding.endpoint_digest.clone(),
        transport_digest: binding.transport_digest.clone(),
        initialize_request_protocol_version: handshake.initialize_request_protocol_version,
        initialize_response_protocol_version: handshake.initialize_response_protocol_version,
        initialized_notification_sent: handshake.initialized_notification_sent,
        session_id_digest: handshake.session_id_digest,
    };
    let (canonical_bytes, readiness_digest) = canonicalize(&record).map_err(|error| {
        McpReadinessError::refused(
            McpReadinessCode::CanonicalEvidenceInvalid,
            format!("readiness evidence is not canonical: {error}"),
        )
    })?;
    Ok(McpTransportReadiness {
        record,
        canonical_bytes: canonical_bytes.into_vec(),
        readiness_digest,
    })
}

fn validate_runtime_process_authority(
    connection: &Connection,
    snapshot: &CurrentAuthoritySnapshot,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
) -> Result<(), McpReadinessError> {
    let premise = snapshot.premise.as_ref().ok_or_else(|| {
        McpReadinessError::refused(
            McpReadinessCode::HostPremiseMissing,
            "current Runtime authority has no complete Host premise",
        )
    })?;
    if runtime_binding.daemon_installation_id() != snapshot.mapping.daemon_installation_id
        || runtime_binding.instance_id() != snapshot.mapping.instance_id
        || runtime_binding.config_revision() != snapshot.mapping.config_revision
        || runtime_binding.config_digest() != &snapshot.mapping.config_digest
        || runtime_binding.premises_digest() != &premise.premises_digest
    {
        return Err(McpReadinessError::refused(
            McpReadinessCode::RuntimeBindingStale,
            "runtime binding is not bound to the exact current Host premise",
        ));
    }
    if process_generation.extension_alias() != runtime_binding.extension_alias()
        || process_generation.controller_generation() != runtime_binding.controller_generation()
        || process_generation.worker_epoch() != runtime_binding.worker_epoch()
        || process_generation.binding_digest() != runtime_binding.binding_digest()
        || process_generation.daemon_installation_id() != runtime_binding.daemon_installation_id()
        || process_generation.instance_id() != runtime_binding.instance_id()
        || process_generation.config_revision() != runtime_binding.config_revision()
        || process_generation.config_digest() != runtime_binding.config_digest()
    {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ProcessGenerationStale,
            "process generation is not the exact generation minted by the runtime binding",
        ));
    }

    let alias = runtime_binding.extension_alias().to_string();
    let controller = runtime_binding.controller_generation().value() as i64;
    let extension = process_generation.extension_generation().value() as i64;
    let state = connection
        .query_row(
            "SELECT current_controller_generation, current_binding_digest,
                    current_extension_generation, current_worker_epoch
             FROM runtime_binding_authority_state WHERE extension_alias = ?1",
            [alias.as_str()],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            McpReadinessError::refused(
                McpReadinessCode::RuntimeBindingMissing,
                format!("runtime binding authority state unavailable: {error}"),
            )
        })?
        .ok_or_else(|| {
            McpReadinessError::refused(
                McpReadinessCode::RuntimeBindingMissing,
                "runtime binding authority state is absent",
            )
        })?;
    let binding_digest = runtime_binding.binding_digest().to_string();
    if state.0 != Some(controller)
        || state.1.as_deref() != Some(binding_digest.as_str())
        || state.2 != Some(extension)
        || state.3.as_deref() != Some(runtime_binding.worker_epoch().as_str())
    {
        return Err(McpReadinessError::refused(
            McpReadinessCode::RuntimeBindingStale,
            "runtime binding is not the current unambiguous authority state",
        ));
    }

    let binding_row = connection
        .query_row(
            "SELECT worker_epoch, daemon_installation_id, instance_id,
                    config_revision, config_digest, premises_digest,
                    service_candidate_digest, binding_digest
             FROM runtime_binding_authority_records
             WHERE extension_alias = ?1 AND controller_generation = ?2",
            params![alias, controller],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            McpReadinessError::refused(
                McpReadinessCode::RuntimeBindingMissing,
                format!("runtime binding record unavailable: {error}"),
            )
        })?
        .ok_or_else(|| {
            McpReadinessError::refused(
                McpReadinessCode::RuntimeBindingMissing,
                "runtime binding record is absent",
            )
        })?;
    if binding_row.0 != runtime_binding.worker_epoch().to_string()
        || binding_row.1 != runtime_binding.daemon_installation_id()
        || binding_row.2 != runtime_binding.instance_id()
        || binding_row.3 != runtime_binding.config_revision()
        || binding_row.4 != runtime_binding.config_digest().to_string()
        || binding_row.5 != runtime_binding.premises_digest().to_string()
        || binding_row.6 != runtime_binding.service_candidate_digest().to_string()
        || binding_row.7 != runtime_binding.binding_digest().to_string()
    {
        return Err(McpReadinessError::refused(
            McpReadinessCode::RuntimeBindingStale,
            "runtime binding record differs from the live binding",
        ));
    }

    let process_row = connection
        .query_row(
            "SELECT worker_epoch, controller_generation, daemon_installation_id,
                    instance_id, config_revision, config_digest,
                    premises_digest, service_candidate_digest, binding_digest
             FROM process_generation_authority_records
             WHERE extension_alias = ?1 AND extension_generation = ?2",
            params![runtime_binding.extension_alias().to_string(), extension],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            McpReadinessError::refused(
                McpReadinessCode::ProcessGenerationMissing,
                format!("process generation record unavailable: {error}"),
            )
        })?
        .ok_or_else(|| {
            McpReadinessError::refused(
                McpReadinessCode::ProcessGenerationMissing,
                "process generation record is absent",
            )
        })?;
    if process_row.0 != process_generation.worker_epoch().to_string()
        || process_row.1 != process_generation.controller_generation().value() as i64
        || process_row.2 != process_generation.daemon_installation_id()
        || process_row.3 != process_generation.instance_id()
        || process_row.4 != process_generation.config_revision()
        || process_row.5 != process_generation.config_digest().to_string()
        || process_row.6 != runtime_binding.premises_digest().to_string()
        || process_row.7 != runtime_binding.service_candidate_digest().to_string()
        || process_row.8 != process_generation.binding_digest().to_string()
    {
        return Err(McpReadinessError::refused(
            McpReadinessCode::ProcessGenerationStale,
            "process generation record differs from the live generation",
        ));
    }
    Ok(())
}

fn map_host_authority_error(error: HostAuthorityError) -> McpReadinessError {
    McpReadinessError::refused(
        McpReadinessCode::HostPremiseStale,
        format!("current Host premise could not be verified: {error}"),
    )
}

fn map_runtime_binding_error(error: RuntimeBindingError) -> McpReadinessError {
    let code = match &error {
        RuntimeBindingError::AuthorityMissing | RuntimeBindingError::AuthorityStateMissing => {
            McpReadinessCode::RuntimeBindingMissing
        }
        RuntimeBindingError::BindingStale(_) | RuntimeBindingError::GenerationConflict { .. } => {
            McpReadinessCode::RuntimeBindingStale
        }
        _ => McpReadinessCode::RuntimeBindingStale,
    };
    McpReadinessError::refused(code, error.to_string())
}

fn map_probe_error(error: McpTransportProbeError) -> McpReadinessError {
    match error {
        McpTransportProbeError::Absent => McpReadinessError::refused(
            McpReadinessCode::ProbeAbsent,
            "transport probe found no endpoint",
        ),
        McpTransportProbeError::Ambiguous(detail) => {
            McpReadinessError::refused(McpReadinessCode::ProbeAmbiguous, detail)
        }
        McpTransportProbeError::Unsupported(detail) => {
            McpReadinessError::refused(McpReadinessCode::ProbeUnsupported, detail)
        }
        McpTransportProbeError::Failed(detail) => {
            McpReadinessError::refused(McpReadinessCode::ProbeFailed, detail)
        }
    }
}

fn as_object<'a>(
    value: &'a CanonicalJsonValue,
    label: &str,
) -> Result<&'a CanonicalJsonObject, McpReadinessError> {
    match value {
        CanonicalJsonValue::Object(object) => Ok(object),
        _ => Err(McpReadinessError::refused(
            McpReadinessCode::ConfiguredTransportAmbiguous,
            format!("{label} is not one closed object"),
        )),
    }
}

fn object_field<'a>(
    object: &'a CanonicalJsonObject,
    field: &str,
    label: &str,
) -> Result<&'a CanonicalJsonValue, McpReadinessError> {
    object.get(field).ok_or_else(|| {
        McpReadinessError::refused(
            McpReadinessCode::ConfiguredServerMissing,
            format!("{label} is missing field {field}"),
        )
    })
}

fn string_field(
    object: &CanonicalJsonObject,
    field: &str,
    label: &str,
) -> Result<String, McpReadinessError> {
    match object_field(object, field, label)? {
        CanonicalJsonValue::String(value) if !value.is_empty() => Ok(value.clone()),
        _ => Err(McpReadinessError::refused(
            McpReadinessCode::ConfiguredTransportMissing,
            format!("{label}.{field} is not a non-empty string"),
        )),
    }
}

fn bool_field(
    object: &CanonicalJsonObject,
    field: &str,
    label: &str,
) -> Result<bool, McpReadinessError> {
    match object_field(object, field, label)? {
        CanonicalJsonValue::Bool(value) => Ok(*value),
        _ => Err(McpReadinessError::refused(
            McpReadinessCode::ConfiguredServerMissing,
            format!("{label}.{field} is not a boolean"),
        )),
    }
}

fn digest_value(
    value: &CanonicalJsonValue,
    label: &str,
) -> Result<Sha256Digest, McpReadinessError> {
    canonicalize(value)
        .map(|(_, digest)| digest)
        .map_err(|error| {
            McpReadinessError::refused(
                McpReadinessCode::CanonicalEvidenceInvalid,
                format!("{label} is not canonical: {error}"),
            )
        })
}

impl fmt::Display for McpTransportBinding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "MCP server {} ({})", self.server_id, self.transport_kind)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_authority::{
        ConfigRevisionMapping, HostAuthorityRevision, InstalledComponentOrigin,
        LinuxServiceCandidate, ModuleActivationPremises, ResolvedConfiguration,
        RuntimeAuthorityIdentity,
    };
    use crate::linux_host_verification::{LinuxHostVerificationCode, test_proof_for_authority};
    use dolly_canonical_json::canonicalize;
    use serde_json::{Value, json};
    use tempfile::{TempDir, tempdir};

    struct FixedProbe {
        observation: Result<McpHandshakeObservation, McpTransportProbeError>,
    }

    impl McpTransportProbe for FixedProbe {
        fn observe(
            &mut self,
            _binding: &McpTransportBinding,
        ) -> Result<McpHandshakeObservation, McpTransportProbeError> {
            self.observation.clone()
        }
    }
    fn prove_current_mcp_transport_readiness<P>(
        connection: &Connection,
        runtime_binding: &RuntimeBinding,
        process_generation: &ProcessGeneration,
        server_id: &str,
        probe: &mut P,
    ) -> Result<McpTransportReadiness, McpReadinessError>
    where
        P: McpTransportProbe,
    {
        let verify_live_host = |connection: &Connection| -> Result<
            VerifiedLinuxHostProof,
            LinuxHostVerificationError,
        > {
            let snapshot = load_current_authority(connection)
                .map_err(|error| LinuxHostVerificationError {
                    code: LinuxHostVerificationCode::PremiseStale,
                    detail: error.to_string(),
                })?
                .ok_or_else(|| LinuxHostVerificationError {
                    code: LinuxHostVerificationCode::PremiseMissing,
                    detail: "test Host premise is absent".into(),
                })?;
            Ok(test_proof_for_authority(&snapshot))
        };
        super::prove_current_mcp_transport_readiness_with_verifier(
            connection,
            runtime_binding,
            process_generation,
            server_id,
            probe,
            verify_live_host,
        )
    }

    struct MutatingProbe<'a> {
        connection: &'a Connection,
        observation: McpHandshakeObservation,
    }

    impl McpTransportProbe for MutatingProbe<'_> {
        fn observe(
            &mut self,
            _binding: &McpTransportBinding,
        ) -> Result<McpHandshakeObservation, McpTransportProbeError> {
            self.connection
                .execute(
                    "UPDATE runtime_authority_state SET record_jcs = X'00' WHERE singleton = 1",
                    [],
                )
                .map_err(|error| McpTransportProbeError::Failed(error.to_string()))?;
            Ok(self.observation.clone())
        }
    }

    fn digest(value: &Value) -> Sha256Digest {
        canonicalize(value).unwrap().1
    }

    fn without(value: &Value, field: &str) -> Value {
        let mut object = value.as_object().unwrap().clone();
        object.remove(field);
        Value::Object(object)
    }

    fn authority_revision(instance_id: &str) -> HostAuthorityRevision {
        let origin = InstalledComponentOrigin {
            schema: "dolly.installed-component-origin/v1".into(),
            kind: "installed_product_component".into(),
            component_id: "org.dolly.host-runtime".into(),
            component_revision: 1,
            component_digest: digest(&json!({"component": "host-runtime"})),
        };
        let mut candidate_record = json!({
            "schema": "dolly.linux-service-candidate/v1",
            "origin": serde_json::to_value(&origin).unwrap(),
            "unit_name": "dollyd@main.service",
            "mode": "user",
            "candidate_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        });
        candidate_record["candidate_digest"] =
            json!(digest(&without(&candidate_record, "candidate_digest")).to_string());
        let candidate: LinuxServiceCandidate = serde_json::from_value(candidate_record).unwrap();
        let transport = json!({
            "kind": "streamable_http",
            "endpoint": "https://tools.example.test/mcp",
            "credential_ref": null,
            "tls_spki_sha256": []
        });
        let server = json!({
            "enabled": true,
            "adapter": "mcp",
            "protocol_version": MCP_PROTOCOL_VERSION_2025_06_18,
            "transport": transport,
            "allowed_modules": [],
            "limits": {
                "startup_timeout_ms": 100,
                "request_timeout_ms": 100,
                "max_concurrency": 1,
                "max_request_bytes": 1024,
                "max_response_bytes": 1024
            },
            "tools": {}
        });
        let runtime = json!({
            "api_version": "dolly.example/v1alpha1",
            "kind": "DollyInstance",
            "metadata": {"instance_id": instance_id, "display_name": "Test"},
            "spec": {
                "pages": {}, "extensions": {}, "modules": {},
                "limits": {},
                "services": {
                    "asset": {}, "model_gateway": {},
                    "tool_broker": {"schema": "dolly.tool-broker-config/v1", "servers": {"server-one": server}},
                    "observability": {}
                },
                "security": {}, "feature_flags": {}
            }
        });
        let config = ResolvedConfiguration {
            runtime_config: CanonicalJsonValue::try_from(runtime).unwrap(),
            permission_policy_selections: Vec::new(),
            service_candidate: Some(candidate.clone()),
        };
        let config_digest = canonicalize(&config).unwrap().1;
        let mut premise_record = json!({
            "schema": "dolly.module-activation-premises/v1",
            "daemon_installation_id": "0198ab31-6c44-7e8a-b2bb-000000000001",
            "instance_id": instance_id,
            "config_revision": 1,
            "config_digest": config_digest,
            "permission_policy_definitions": [],
            "permission_policy_backend_bindings": [],
            "service_candidate": serde_json::to_value(&candidate).unwrap(),
            "premises_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        });
        premise_record["premises_digest"] =
            json!(digest(&without(&premise_record, "premises_digest")).to_string());
        let premise: ModuleActivationPremises = serde_json::from_value(premise_record).unwrap();
        HostAuthorityRevision {
            identity: RuntimeAuthorityIdentity {
                daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000001".into(),
                instance_id: instance_id.into(),
            },
            mapping: ConfigRevisionMapping {
                schema: "dolly.config-revision-mapping/v1".into(),
                daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000001".into(),
                instance_id: instance_id.into(),
                config_revision: 1,
                config_digest,
                canonical_config: config,
            },
            premise: Some(premise),
        }
    }

    fn durable_database() -> (TempDir, Database, CurrentAuthoritySnapshot) {
        let directory = tempdir().unwrap();
        let suffix = directory
            .path()
            .file_name()
            .expect("temp directory name")
            .to_string_lossy()
            .replace('.', "d")
            .to_ascii_lowercase();
        let instance_id = format!("instance-{suffix}");
        let path = directory.path().join("runtime.sqlite3");
        let db = Database::open_for_migration(&path)
            .unwrap()
            .install_host_authority_revision(authority_revision(&instance_id))
            .unwrap();
        let snapshot = load_current_authority(db.connection()).unwrap().unwrap();
        (directory, db, snapshot)
    }

    fn successful_observation(
        binding: &McpTransportBinding,
        runtime: &RuntimeBinding,
        process: &ProcessGeneration,
    ) -> McpHandshakeObservation {
        McpHandshakeObservation {
            server_id: Some(binding.server_id().to_string()),
            adapter: Some(binding.adapter().to_string()),
            daemon_installation_id: Some(runtime.daemon_installation_id().to_string()),
            instance_id: Some(runtime.instance_id().to_string()),
            controller_generation: Some(runtime.controller_generation()),
            worker_epoch: Some(runtime.worker_epoch().clone()),
            extension_alias: Some(runtime.extension_alias().clone()),
            extension_generation: Some(process.extension_generation()),
            runtime_binding_digest: Some(runtime.binding_digest().clone()),
            transport_kind: Some(binding.transport_kind().to_string()),
            endpoint: Some(binding.endpoint().to_string()),
            transport_digest: Some(binding.transport_digest().clone()),
            initialize_request_protocol_version: Some(MCP_PROTOCOL_VERSION_2025_06_18.into()),
            initialize_response_protocol_version: Some(MCP_PROTOCOL_VERSION_2025_06_18.into()),
            initialized_notification_sent: true,
            session_ids: vec!["session-one".into()],
        }
    }

    #[test]
    fn exact_binding_and_handshake_mint_only_private_evidence() {
        let (_directory, mut db, snapshot) = durable_database();
        let mut runtime = mint_runtime_binding(
            &mut db,
            "org.dolly.test".parse().unwrap(),
            test_proof_for_authority(&snapshot),
        )
        .unwrap();
        let process = runtime.mint_process_generation(&mut db).unwrap();
        let binding = load_mcp_transport_binding(&snapshot, "server-one").unwrap();
        let mut probe = FixedProbe {
            observation: Ok(successful_observation(&binding, &runtime, &process)),
        };
        let readiness = prove_current_mcp_transport_readiness(
            db.connection(),
            &runtime,
            &process,
            "server-one",
            &mut probe,
        )
        .unwrap();
        assert_eq!(readiness.schema(), MCP_TRANSPORT_READINESS_SCHEMA);
        assert_eq!(readiness.server_id(), "server-one");
        assert_eq!(
            readiness.protocol_version(),
            MCP_PROTOCOL_VERSION_2025_06_18
        );
        assert_eq!(
            readiness.controller_generation().value(),
            runtime.controller_generation().value()
        );
        assert_eq!(
            readiness.extension_generation().value(),
            process.extension_generation().value()
        );
        assert_eq!(readiness.binding_digest(), runtime.binding_digest());
        assert_eq!(
            canonicalize(&readiness.record).unwrap().0.as_bytes(),
            readiness.canonical_bytes.as_slice()
        );
        assert_eq!(
            canonicalize(&readiness.record).unwrap().1,
            *readiness.readiness_digest()
        );
        let tables: i64 = db
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'tool_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0);
    }

    #[test]
    fn mismatches_stale_and_ambiguous_observations_fail_closed() {
        let (_directory, mut db, snapshot) = durable_database();
        let mut runtime = mint_runtime_binding(
            &mut db,
            "org.dolly.test".parse().unwrap(),
            test_proof_for_authority(&snapshot),
        )
        .unwrap();
        let process = runtime.mint_process_generation(&mut db).unwrap();
        let binding = load_mcp_transport_binding(&snapshot, "server-one").unwrap();
        let mut bad = successful_observation(&binding, &runtime, &process);
        bad.endpoint = Some("https://other.example.test/mcp".into());
        let mut probe = FixedProbe {
            observation: Ok(bad),
        };
        let error = prove_current_mcp_transport_readiness(
            db.connection(),
            &runtime,
            &process,
            "server-one",
            &mut probe,
        )
        .unwrap_err();
        assert_eq!(error.code, McpReadinessCode::HandshakeEndpointMismatch);
        let mut identity = successful_observation(&binding, &runtime, &process);
        identity.server_id = Some("other-server".into());
        let mut probe = FixedProbe {
            observation: Ok(identity),
        };
        let error = prove_current_mcp_transport_readiness(
            db.connection(),
            &runtime,
            &process,
            "server-one",
            &mut probe,
        )
        .unwrap_err();
        assert_eq!(error.code, McpReadinessCode::HandshakeIdentityMismatch);
        let mut adapter = successful_observation(&binding, &runtime, &process);
        adapter.adapter = Some("other-adapter".into());
        let mut probe = FixedProbe {
            observation: Ok(adapter),
        };
        let error = prove_current_mcp_transport_readiness(
            db.connection(),
            &runtime,
            &process,
            "server-one",
            &mut probe,
        )
        .unwrap_err();
        assert_eq!(error.code, McpReadinessCode::HandshakeIdentityMismatch);

        let mut controller = successful_observation(&binding, &runtime, &process);
        controller.controller_generation =
            Some(ExtensionGeneration::new(runtime.controller_generation().value() + 1).unwrap());
        let mut probe = FixedProbe {
            observation: Ok(controller),
        };
        let error = prove_current_mcp_transport_readiness(
            db.connection(),
            &runtime,
            &process,
            "server-one",
            &mut probe,
        )
        .unwrap_err();
        assert_eq!(error.code, McpReadinessCode::HandshakeIdentityMismatch);

        let mut version = successful_observation(&binding, &runtime, &process);
        version.initialize_response_protocol_version = Some("2026-07-28".into());
        let mut probe = FixedProbe {
            observation: Ok(version),
        };
        let error = prove_current_mcp_transport_readiness(
            db.connection(),
            &runtime,
            &process,
            "server-one",
            &mut probe,
        )
        .unwrap_err();
        assert_eq!(error.code, McpReadinessCode::HandshakeProtocolMismatch);

        let mut absent = successful_observation(&binding, &runtime, &process);
        absent.transport_digest = None;
        let mut probe = FixedProbe {
            observation: Ok(absent),
        };
        let error = prove_current_mcp_transport_readiness(
            db.connection(),
            &runtime,
            &process,
            "server-one",
            &mut probe,
        )
        .unwrap_err();
        assert_eq!(error.code, McpReadinessCode::ProbeAbsent);

        let mut probe = FixedProbe {
            observation: Err(McpTransportProbeError::Ambiguous(
                "two endpoint sessions observed".into(),
            )),
        };
        let error = prove_current_mcp_transport_readiness(
            db.connection(),
            &runtime,
            &process,
            "server-one",
            &mut probe,
        )
        .unwrap_err();
        assert_eq!(error.code, McpReadinessCode::ProbeAmbiguous);

        let mut no_session = successful_observation(&binding, &runtime, &process);
        no_session.session_ids.clear();
        let mut probe = FixedProbe {
            observation: Ok(no_session),
        };
        let error = prove_current_mcp_transport_readiness(
            db.connection(),
            &runtime,
            &process,
            "server-one",
            &mut probe,
        )
        .unwrap_err();
        assert_eq!(error.code, McpReadinessCode::HandshakeSessionAbsent);

        let mut ambiguous = successful_observation(&binding, &runtime, &process);
        ambiguous.session_ids.push("session-two".into());
        let mut probe = FixedProbe {
            observation: Ok(ambiguous),
        };
        let error = prove_current_mcp_transport_readiness(
            db.connection(),
            &runtime,
            &process,
            "server-one",
            &mut probe,
        )
        .unwrap_err();
        assert_eq!(error.code, McpReadinessCode::HandshakeSessionAmbiguous);

        db.connection().execute(
            "UPDATE runtime_binding_authority_state SET current_extension_generation = NULL WHERE extension_alias = ?1",
            ["org.dolly.test"],
        ).unwrap();
        let mut probe = FixedProbe {
            observation: Ok(successful_observation(&binding, &runtime, &process)),
        };
        let error = prove_current_mcp_transport_readiness(
            db.connection(),
            &runtime,
            &process,
            "server-one",
            &mut probe,
        )
        .unwrap_err();
        assert_eq!(error.code, McpReadinessCode::RuntimeBindingStale);
    }
    #[test]
    fn live_host_proof_mutation_after_handshake_refuses_before_publication() {
        let (_directory, mut db, snapshot) = durable_database();
        let mut runtime = mint_runtime_binding(
            &mut db,
            "org.dolly.test".parse().unwrap(),
            test_proof_for_authority(&snapshot),
        )
        .unwrap();
        let process = runtime.mint_process_generation(&mut db).unwrap();
        let binding = load_mcp_transport_binding(&snapshot, "server-one").unwrap();
        let mut foreign_snapshot = snapshot.clone();
        foreign_snapshot.mapping.instance_id = "other-instance".into();
        let mut probe = FixedProbe {
            observation: Ok(successful_observation(&binding, &runtime, &process)),
        };
        let error = super::prove_current_mcp_transport_readiness_with_verifier(
            db.connection(),
            &runtime,
            &process,
            "server-one",
            &mut probe,
            |_connection| Ok(test_proof_for_authority(&foreign_snapshot)),
        )
        .unwrap_err();
        assert_eq!(error.code, McpReadinessCode::HostPremiseStale);
    }
    #[test]
    fn host_premise_mutation_during_handshake_refuses_without_readiness() {
        let (_directory, mut db, snapshot) = durable_database();
        let mut runtime = mint_runtime_binding(
            &mut db,
            "org.dolly.test".parse().unwrap(),
            test_proof_for_authority(&snapshot),
        )
        .unwrap();
        let process = runtime.mint_process_generation(&mut db).unwrap();
        let binding = load_mcp_transport_binding(&snapshot, "server-one").unwrap();
        let mut probe = MutatingProbe {
            connection: db.connection(),
            observation: successful_observation(&binding, &runtime, &process),
        };
        let error = prove_current_mcp_transport_readiness(
            db.connection(),
            &runtime,
            &process,
            "server-one",
            &mut probe,
        )
        .unwrap_err();
        assert_eq!(error.code, McpReadinessCode::HostPremiseStale);
    }
}
