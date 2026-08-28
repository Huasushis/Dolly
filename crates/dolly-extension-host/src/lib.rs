//! G2 admission from the accepted G1 dispatch proof.
//!
//! [`admit_activation`] consumes the opaque G1 [`ExecutionPremise`] and the
//! [`DispatchResult`] returned after Core durably recorded `started`. It parses
//! the exact canonical `module.activate` request, checks every request,
//! connection, lease, generation, revision, digest, configuration, Manifest,
//! and ordering fence, then returns immutable data for a later Extension
//! handler. This crate has no transport writer, process launcher, or effect
//! executor.

use dolly_canonical_json::{
    CanonicalBytes, CanonicalJsonObject, CanonicalJsonValue, ParseLimits, Sha256Digest,
    canonicalize, parse_core_json,
};
use dolly_core_domain::{
    Attempt, ExtensionGeneration, LeaseGeneration, LeaseToken, ModuleId, WorkerEpoch,
};
use dolly_core_reducer::{ActivationState, TransitionOutcome};
use dolly_extension_sdk::{CapabilityRequest as SdkCapabilityRequest, ResultData};
use dolly_protocol::{FrameLimits, MessageKind, message::decode_message};
use dolly_runtime::{
    DispatchResult, ExecutionOrder, ExecutionPremise, ReplayEvidence, ReplayMode, ReplayScope,
};
use dolly_schema::{ActivationManifest, BlockEnvelope, embedded_schema_catalog};
use serde::de::{DeserializeOwned, IntoDeserializer};
use serde::{Deserialize, Serialize, Serializer};
use thiserror::Error;
/// The only invocation method admitted by this G2 boundary.
pub const MODULE_ACTIVATE_METHOD: &str = "module.activate";
/// The schema root for `module.activate` parameters.
pub const ACTIVATION_REQUEST_SCHEMA_ID: &str =
    "https://dolly.example/spec/0.1/schemas/activation-request.schema.json";

/// Direction of a closed Extension RPC request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RpcDirection {
    /// Host sends a lifecycle or activation request to an Extension.
    HostToExtension,
    /// Extension sends a Host-service request to the Host.
    ExtensionToHost,
}

/// The immutable G2 premise produced only after G1 dispatch admission.
#[derive(Clone, Debug)]
pub struct FencedInvocationPremise {
    activation_id: String,
    module_id: String,
    request_id: String,
    reservation_id: String,
    lease_id: String,
    worker_epoch: WorkerEpoch,
    worker_epoch_fence: i64,
    incarnation_revision: i64,
    extension_connection_id: String,
    extension_generation: i64,
    lease_generation: i64,
    attempt: i64,
    lease_token: LeaseToken,
    lease_token_digest: Sha256Digest,
    frame_digest: Sha256Digest,
    graph_digest: Sha256Digest,
    descriptor_digest: Sha256Digest,
    manifest_digest: Sha256Digest,
    effective_config_digest: Sha256Digest,
    effective_config_schema_digest: Sha256Digest,
    manifest: ActivationManifest,
    order: ExecutionOrder,
    replay_scope: ReplayScope,
}

impl FencedInvocationPremise {
    pub fn activation_id(&self) -> &str {
        &self.activation_id
    }
    pub fn module_id(&self) -> &str {
        &self.module_id
    }
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
    pub fn reservation_id(&self) -> &str {
        &self.reservation_id
    }
    pub fn lease_id(&self) -> &str {
        &self.lease_id
    }
    pub fn worker_epoch(&self) -> &WorkerEpoch {
        &self.worker_epoch
    }
    pub fn worker_epoch_fence(&self) -> i64 {
        self.worker_epoch_fence
    }
    pub fn incarnation_revision(&self) -> i64 {
        self.incarnation_revision
    }
    pub fn extension_connection_id(&self) -> &str {
        &self.extension_connection_id
    }
    pub fn extension_generation(&self) -> i64 {
        self.extension_generation
    }
    pub fn lease_generation(&self) -> i64 {
        self.lease_generation
    }
    pub fn attempt(&self) -> i64 {
        self.attempt
    }
    pub fn lease_token_digest(&self) -> &Sha256Digest {
        &self.lease_token_digest
    }
    pub fn frame_digest(&self) -> &Sha256Digest {
        &self.frame_digest
    }
    pub fn graph_digest(&self) -> &Sha256Digest {
        &self.graph_digest
    }
    pub fn descriptor_digest(&self) -> &Sha256Digest {
        &self.descriptor_digest
    }
    pub fn manifest_digest(&self) -> &Sha256Digest {
        &self.manifest_digest
    }
    pub fn effective_config_digest(&self) -> &Sha256Digest {
        &self.effective_config_digest
    }
    pub fn effective_config_schema_digest(&self) -> &Sha256Digest {
        &self.effective_config_schema_digest
    }
    pub fn manifest(&self) -> &ActivationManifest {
        &self.manifest
    }
    pub fn order(&self) -> &ExecutionOrder {
        &self.order
    }
    pub fn replay_scope(&self) -> &ReplayScope {
        &self.replay_scope
    }

    /// Stable key for a durable replay ledger. The Host owns persistence.
    pub fn replay_key(&self) -> (String, String) {
        (
            self.activation_id.clone(),
            self.manifest_digest.to_canonical_string(),
        )
    }
    /// Build a canonical result receipt after invocation admission.
    pub fn result_receipt(&self, result: &ResultData) -> Result<InvocationReceipt, AdmissionError> {
        let payload = result
            .canonical_value()
            .map_err(|_| AdmissionError::InvalidResult)?;
        let result_digest = result.digest().map_err(|_| AdmissionError::InvalidResult)?;
        let receipt_value = serde_json::json!({
            "invocation": {
                "activation_id": self.activation_id,
                "module_id": self.module_id,
                "request_id": self.request_id,
                "frame_digest": self.frame_digest,
                "replay_key": {
                    "activation_id": self.activation_id,
                    "manifest_digest": self.manifest_digest,
                },
            },
            "result": {
                "worker_epoch": self.worker_epoch.to_string(),
                "extension_generation": self.extension_generation,
                "activation_id": self.activation_id,
                "manifest_digest": self.manifest_digest,
                "lease_generation": self.lease_generation,
                "lease_token": self.lease_token.expose_base64url(),
                "payload": payload,
                "result_digest": result_digest,
            },
        });
        let (bytes, receipt_digest) =
            canonicalize(&receipt_value).map_err(|_| AdmissionError::InvalidResult)?;
        Ok(InvocationReceipt {
            activation_id: self.activation_id.clone(),
            manifest_digest: self.manifest_digest.clone(),
            result_digest,
            receipt_digest,
            bytes,
            result: result.clone(),
        })
    }
}
/// Canonical result and invocation receipt produced after G2 admission.
///
/// The SDK can supply only [`ResultData`]. All identity, lease, frame, and
/// replay fields are copied from the opaque [`FencedInvocationPremise`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvocationReceipt {
    activation_id: String,
    manifest_digest: Sha256Digest,
    result_digest: Sha256Digest,
    receipt_digest: Sha256Digest,
    bytes: CanonicalBytes,
    result: ResultData,
}

impl InvocationReceipt {
    pub fn activation_id(&self) -> &str {
        &self.activation_id
    }

    pub fn manifest_digest(&self) -> &Sha256Digest {
        &self.manifest_digest
    }

    pub fn replay_key(&self) -> (String, String) {
        (
            self.activation_id.clone(),
            self.manifest_digest.to_canonical_string(),
        )
    }

    pub fn result_digest(&self) -> &Sha256Digest {
        &self.result_digest
    }

    pub fn receipt_digest(&self) -> &Sha256Digest {
        &self.receipt_digest
    }

    pub fn result(&self) -> &ResultData {
        &self.result
    }

    /// Canonical receipt bytes. Sending or persisting them is outside G2.
    pub fn bytes(&self) -> &[u8] {
        self.bytes.as_bytes()
    }
}

/// A durable descriptor/Manifest capability projection used for one refusal
/// check. It is policy data, not a capability token and has no executor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityProjection {
    extension_id: String,
    module_id: String,
    manifest_digest: Sha256Digest,
    declared_methods: Vec<String>,
}

impl CapabilityProjection {
    /// Construct a closed projection from Host-owned policy data.
    pub fn new(
        extension_id: &str,
        module_id: &str,
        manifest_digest: &str,
        declared_methods: Vec<String>,
    ) -> Result<Self, AdmissionError> {
        if extension_id.is_empty()
            || module_id.parse::<ModuleId>().is_err()
            || manifest_digest.parse::<Sha256Digest>().is_err()
            || declared_methods.is_empty()
            || declared_methods.iter().any(|method| {
                method.is_empty() || !method.starts_with("host.") || method.len() > 160
            })
        {
            return Err(AdmissionError::CapabilityDenied);
        }
        let manifest_digest = manifest_digest
            .parse::<Sha256Digest>()
            .map_err(|_| AdmissionError::CapabilityDenied)?;
        Ok(Self {
            extension_id: extension_id.to_owned(),
            module_id: module_id.to_owned(),
            manifest_digest,
            declared_methods,
        })
    }
}

/// Untrusted Extension capability request data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityRequest {
    extension_id: String,
    module_id: String,
    manifest_digest: Sha256Digest,
    method: String,
    direction: RpcDirection,
}

impl CapabilityRequest {
    /// Parse a request without granting authority or calling a service.
    pub fn new(
        extension_id: &str,
        module_id: &str,
        manifest_digest: &str,
        method: &str,
        direction: RpcDirection,
    ) -> Result<Self, AdmissionError> {
        if extension_id.is_empty()
            || module_id.parse::<ModuleId>().is_err()
            || method.is_empty()
            || method.len() > 160
            || !method.starts_with("host.")
            || direction != RpcDirection::ExtensionToHost
        {
            return Err(AdmissionError::CapabilityDenied);
        }
        Ok(Self {
            extension_id: extension_id.to_owned(),
            module_id: module_id.to_owned(),
            manifest_digest: manifest_digest
                .parse()
                .map_err(|_| AdmissionError::CapabilityDenied)?,
            method: method.to_owned(),
            direction,
        })
    }
}

/// Admit only a method declared for the exact Extension/Module/Manifest.
///
/// The return value is intentionally unit: this G2 lane stops before any
/// Host-service or external-effect call.
pub fn admit_capability(
    projection: &CapabilityProjection,
    request: &CapabilityRequest,
) -> Result<(), AdmissionError> {
    if request.direction != RpcDirection::ExtensionToHost
        || request.extension_id != projection.extension_id
        || request.module_id != projection.module_id
        || request.manifest_digest != projection.manifest_digest
        || !projection
            .declared_methods
            .iter()
            .any(|method| method == &request.method)
    {
        return Err(AdmissionError::CapabilityDenied);
    }
    Ok(())
}

/// Capability request data that passed Host admission. It has no executor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdmittedCapabilityRequest {
    method: String,
    arguments: CanonicalJsonObject,
}

impl AdmittedCapabilityRequest {
    pub fn method(&self) -> &str {
        &self.method
    }

    pub fn arguments(&self) -> &CanonicalJsonObject {
        &self.arguments
    }
}

/// Consume SDK request data only after the G1-derived premise exists.
pub fn admit_sdk_capability(
    premise: &FencedInvocationPremise,
    projection: &CapabilityProjection,
    request: SdkCapabilityRequest,
) -> Result<AdmittedCapabilityRequest, AdmissionError> {
    if projection.module_id != premise.module_id
        || projection.manifest_digest != premise.manifest_digest
        || !projection
            .declared_methods
            .iter()
            .any(|method| method == request.method())
    {
        return Err(AdmissionError::CapabilityDenied);
    }
    Ok(AdmittedCapabilityRequest {
        method: request.method().to_owned(),
        arguments: request.arguments().clone(),
    })
}

/// Fail-closed G2 admission errors. Raw lease tokens are never included.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum AdmissionError {
    #[error("invalid module.activate frame: {0}")]
    InvalidFrame(&'static str),
    #[error("module.activate frame rejected: {0}")]
    FrameRejected(String),
    #[error("G1 dispatch is not durably committed")]
    DispatchNotCommitted,
    #[error("G1 fence mismatch: {0}")]
    FenceMismatch(&'static str),
    #[error("SDK result data is invalid")]
    InvalidResult,
    #[error("capability is undeclared, cross-Extension, stale, or reversed")]
    CapabilityDenied,
}

#[derive(Clone, Debug)]
struct ParsedActivation {
    request_id: String,
    worker_epoch: WorkerEpoch,
    extension_generation: i64,
    lease_generation: i64,
    attempt: i64,
    manifest: ActivationManifest,
    manifest_value: CanonicalJsonValue,
    lease_token: LeaseToken,
    lease_token_digest: Sha256Digest,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireActivationRequest {
    worker_epoch: WorkerEpoch,
    extension_generation: ExtensionGeneration,
    lease_generation: LeaseGeneration,
    lease_token: LeaseToken,
    attempt: Attempt,
    manifest: ActivationManifest,
}

/// Parse and admit the exact frame emitted by G1 after durable `started`.
pub fn admit_activation(
    premise: &ExecutionPremise,
    dispatch: &DispatchResult,
    limits: FrameLimits,
) -> Result<FencedInvocationPremise, AdmissionError> {
    let parsed = parse_frame(dispatch, limits)?;
    if dispatch.transition().outcome != TransitionOutcome::Committed {
        return Err(AdmissionError::DispatchNotCommitted);
    }
    validate_frame(premise, dispatch, &parsed, limits)?;
    validate_durable_state(premise, dispatch, &parsed)?;
    Ok(FencedInvocationPremise {
        activation_id: premise.identity().activation_id().to_owned(),
        module_id: premise.identity().module_id().to_owned(),
        request_id: premise.fence().request_id().to_owned(),
        reservation_id: premise.fence().reservation_id().to_owned(),
        lease_id: premise.fence().lease_id().to_owned(),
        worker_epoch: premise.fence().worker_epoch().clone(),
        worker_epoch_fence: premise.fence().worker_epoch_fence(),
        incarnation_revision: premise.fence().incarnation_revision(),
        extension_connection_id: premise.fence().extension_connection_id().to_owned(),
        extension_generation: premise.fence().extension_generation(),
        lease_generation: premise.fence().lease_generation(),
        attempt: premise.fence().attempt(),
        lease_token: parsed.lease_token,
        lease_token_digest: parsed.lease_token_digest,
        frame_digest: dispatch
            .frame_digest()
            .parse()
            .map_err(|_| AdmissionError::FenceMismatch("frame_digest"))?,
        graph_digest: premise
            .digests()
            .graph_digest()
            .parse()
            .map_err(|_| AdmissionError::FenceMismatch("graph_digest"))?,
        descriptor_digest: premise
            .digests()
            .descriptor_digest()
            .parse()
            .map_err(|_| AdmissionError::FenceMismatch("descriptor_digest"))?,
        manifest_digest: parsed.manifest.manifest_digest.clone(),
        effective_config_digest: parsed.manifest.effective_config_digest.clone(),
        effective_config_schema_digest: parsed.manifest.effective_config_schema_digest.clone(),
        manifest: parsed.manifest,
        order: premise.order().clone(),
        replay_scope: premise.replay_scope().clone(),
    })
}

fn parse_frame(
    dispatch: &DispatchResult,
    limits: FrameLimits,
) -> Result<ParsedActivation, AdmissionError> {
    let frame = dispatch.frame_bytes();
    if frame.len() > limits.max_frame_bytes() as usize {
        return Err(AdmissionError::FrameRejected(
            "frame exceeds negotiated limit".into(),
        ));
    }
    let message = decode_message(frame, limits)
        .map_err(|error| AdmissionError::FrameRejected(error.to_string()))?;
    if message.kind != MessageKind::Request || message.method() != Some(MODULE_ACTIVATE_METHOD) {
        return Err(AdmissionError::InvalidFrame("method direction"));
    }
    let CanonicalJsonValue::Object(body) = message.body() else {
        return Err(AdmissionError::InvalidFrame("request envelope"));
    };
    if body.len() != 4
        || body.get("jsonrpc").is_none()
        || body.get("id").is_none()
        || body.get("method").is_none()
        || body.get("params").is_none()
        || body
            .iter()
            .any(|(key, _)| !matches!(key, "jsonrpc" | "id" | "method" | "params"))
    {
        return Err(AdmissionError::InvalidFrame("closed request envelope"));
    }
    let params = message
        .payload()
        .ok_or(AdmissionError::InvalidFrame("params"))?;
    let catalog = embedded_schema_catalog()
        .map_err(|_| AdmissionError::InvalidFrame("activation schema catalog"))?;
    catalog
        .validate(
            ACTIVATION_REQUEST_SCHEMA_ID,
            params,
            limits.semantic_payload_depth_limit(),
        )
        .map_err(|_| AdmissionError::InvalidFrame("activation request schema"))?;
    let wire: WireActivationRequest = deserialize_canonical(params)
        .map_err(|_| AdmissionError::InvalidFrame("activation request fields"))?;
    if wire.attempt.value() == 0 {
        return Err(AdmissionError::InvalidFrame("attempt"));
    }
    let CanonicalJsonValue::Object(params_object) = params else {
        return Err(AdmissionError::InvalidFrame("params"));
    };
    let manifest_value = params_object
        .get("manifest")
        .cloned()
        .ok_or(AdmissionError::InvalidFrame("manifest"))?;
    let (_, digest) = canonical_without_field(&manifest_value, "manifest_digest")?;
    if wire.manifest.manifest_digest != digest {
        return Err(AdmissionError::FenceMismatch("manifest_digest"));
    }
    let request_id = message
        .id
        .ok_or(AdmissionError::InvalidFrame("request id"))?;
    let lease_token = wire.lease_token;
    let lease_token_digest = Sha256Digest::compute(lease_token.expose_bytes());
    Ok(ParsedActivation {
        request_id,
        worker_epoch: wire.worker_epoch,
        extension_generation: wire.extension_generation.value() as i64,
        lease_generation: wire.lease_generation.value() as i64,
        attempt: wire.attempt.value() as i64,
        manifest: wire.manifest,
        manifest_value,
        lease_token,
        lease_token_digest,
    })
}

fn validate_frame(
    premise: &ExecutionPremise,
    dispatch: &DispatchResult,
    parsed: &ParsedActivation,
    limits: FrameLimits,
) -> Result<(), AdmissionError> {
    let frame_digest: Sha256Digest = dispatch
        .frame_digest()
        .parse()
        .map_err(|_| AdmissionError::FenceMismatch("frame_digest"))?;
    frame_digest
        .verify_bytes(dispatch.frame_bytes())
        .map_err(|_| AdmissionError::FenceMismatch("frame_digest bytes"))?;
    let canonical_frame = canonicalize(&decode_canonical_frame(dispatch.frame_bytes(), limits)?)
        .map_err(|_| AdmissionError::InvalidFrame("canonical frame"))?;
    if canonical_frame.0.as_bytes() != dispatch.frame_bytes() {
        return Err(AdmissionError::InvalidFrame("non-canonical frame"));
    }
    if parsed.worker_epoch != *premise.fence().worker_epoch()
        || parsed.extension_generation != premise.fence().extension_generation()
        || parsed.lease_generation != premise.fence().lease_generation()
        || parsed.attempt != premise.fence().attempt()
    {
        return Err(AdmissionError::FenceMismatch("invocation fence"));
    }
    if parsed.request_id != premise.fence().request_id()
        || parsed.manifest.activation_id.to_string() != premise.identity().activation_id()
        || parsed.manifest.module_id.to_string() != premise.identity().module_id()
    {
        return Err(AdmissionError::FenceMismatch("invocation identity"));
    }
    if parsed.manifest.manifest_digest.to_string() != premise.digests().manifest_digest()
        || parsed.manifest.effective_config_digest.to_string()
            != premise.digests().effective_config_digest()
        || parsed.manifest.effective_config_schema_digest.to_string()
            != premise.digests().effective_config_schema_digest()
    {
        return Err(AdmissionError::FenceMismatch("manifest/config digest"));
    }
    let typed_manifest_value = canonical_value(&parsed.manifest)?;
    if typed_manifest_value != parsed.manifest_value {
        return Err(AdmissionError::FenceMismatch("manifest bytes"));
    }
    if parsed.manifest.required_frame_bytes < dispatch.frame_bytes().len() as u64
        || parsed.manifest.required_frame_nesting_depth
            < frame_nesting_depth(dispatch.frame_bytes())
    {
        return Err(AdmissionError::FenceMismatch("frame bounds"));
    }
    if parsed.lease_token_digest.to_string() != durable_token_digest(premise, dispatch)? {
        return Err(AdmissionError::FenceMismatch("token_hash"));
    }
    validate_order(&parsed.manifest, premise.order())?;
    validate_replay_scope(&parsed.manifest, premise.replay_scope())?;
    Ok(())
}

fn validate_durable_state(
    premise: &ExecutionPremise,
    dispatch: &DispatchResult,
    parsed: &ParsedActivation,
) -> Result<(), AdmissionError> {
    let state = &dispatch.transition().state;
    let activation_id = premise.identity().activation_id();
    let activation = state
        .activations
        .get(activation_id)
        .ok_or(AdmissionError::FenceMismatch("activation state"))?;
    if activation.state != ActivationState::Dispatched
        || activation.attempt != premise.fence().attempt()
        || activation.extension_generation != Some(premise.fence().extension_generation())
    {
        return Err(AdmissionError::FenceMismatch("activation state"));
    }
    let manifest_value = serde_json::to_value(&parsed.manifest)
        .map_err(|_| AdmissionError::FenceMismatch("manifest serialization"))?;
    if activation.manifest.as_ref() != Some(&manifest_value)
        || state.manifests.get(activation_id) != Some(&manifest_value)
    {
        return Err(AdmissionError::FenceMismatch("retained manifest"));
    }
    let lease = state
        .leases
        .get(premise.fence().lease_id())
        .ok_or(AdmissionError::FenceMismatch("lease"))?;
    require_str(lease, "activation_id", activation_id)?;
    require_str(lease, "reservation_id", premise.fence().reservation_id())?;
    require_str(lease, "request_id", premise.fence().request_id())?;
    require_str(
        lease,
        "extension_connection_id",
        premise.fence().extension_connection_id(),
    )?;
    require_str(
        lease,
        "worker_epoch_id",
        &premise.fence().worker_epoch().to_string(),
    )?;
    require_str(lease, "dispatch_state", "started")?;
    require_str(lease, "frame_digest", dispatch.frame_digest())?;
    require_str(
        lease,
        "manifest_digest",
        premise.digests().manifest_digest(),
    )?;
    require_i64(lease, "worker_epoch", premise.fence().worker_epoch_fence())?;
    require_i64(
        lease,
        "incarnation_revision",
        premise.fence().incarnation_revision(),
    )?;
    require_i64(lease, "attempt", premise.fence().attempt())?;
    require_i64(
        lease,
        "extension_generation",
        premise.fence().extension_generation(),
    )?;
    require_str(
        lease,
        "token_digest",
        &parsed.lease_token_digest.to_string(),
    )?;
    let reservation = state
        .host_request_reservations
        .get(premise.fence().reservation_id())
        .ok_or(AdmissionError::FenceMismatch("request reservation"))?;
    require_str(reservation, "state", "bound")?;
    require_str(reservation, "activation_id", activation_id)?;
    require_str(reservation, "lease_id", premise.fence().lease_id())?;
    require_str(reservation, "request_id", premise.fence().request_id())?;
    require_str(
        reservation,
        "extension_connection_id",
        premise.fence().extension_connection_id(),
    )?;
    require_str(
        reservation,
        "worker_epoch_id",
        &premise.fence().worker_epoch().to_string(),
    )?;
    require_i64(
        reservation,
        "worker_epoch",
        premise.fence().worker_epoch_fence(),
    )?;
    require_i64(
        reservation,
        "incarnation_revision",
        premise.fence().incarnation_revision(),
    )?;
    let connection = state
        .host_connection
        .as_ref()
        .ok_or(AdmissionError::FenceMismatch("Host connection"))?;
    if connection.identity.extension_connection_id != premise.fence().extension_connection_id()
        || connection.identity.worker_epoch_id != premise.fence().worker_epoch().to_string()
        || connection.identity.worker_epoch_fence != premise.fence().worker_epoch_fence()
        || connection.incarnation_revision != premise.fence().incarnation_revision()
    {
        return Err(AdmissionError::FenceMismatch("Host connection"));
    }
    if let Some(current_generation) = state.current_generation {
        if current_generation != premise.fence().extension_generation() {
            return Err(AdmissionError::FenceMismatch("current generation"));
        }
    }
    Ok(())
}

fn durable_token_digest(
    premise: &ExecutionPremise,
    dispatch: &DispatchResult,
) -> Result<String, AdmissionError> {
    dispatch
        .transition()
        .state
        .leases
        .get(premise.fence().lease_id())
        .and_then(|lease| lease.get("token_digest"))
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .ok_or(AdmissionError::FenceMismatch("token_hash"))
}

fn validate_order(
    manifest: &ActivationManifest,
    order: &ExecutionOrder,
) -> Result<(), AdmissionError> {
    if manifest.input_items.len() != order.input_items().len()
        || manifest.cursor_spans.len() != order.cursor_spans().len()
        || manifest.lossy_gaps.len() != order.lossy_gaps().len()
        || manifest.output_page_ids.len() != order.output_page_ids().len()
    {
        return Err(AdmissionError::FenceMismatch("order"));
    }
    for (item, expected) in manifest.input_items.iter().zip(order.input_items()) {
        let block: BlockEnvelope = deserialize_canonical(&canonical_value(&item.block)?)
            .map_err(|_| AdmissionError::FenceMismatch("input block"))?;
        if block.id.to_string() != expected.block_id()
            || block.envelope_digest.to_string() != expected.block_digest()
            || item.occurrence_count != expected.occurrences().len() as u64
            || item.occurrences.len() != expected.occurrences().len()
        {
            return Err(AdmissionError::FenceMismatch("input order"));
        }
        for (occurrence, expected_occurrence) in item.occurrences.iter().zip(expected.occurrences())
        {
            if occurrence.page_id.to_string() != expected_occurrence.page_id()
                || occurrence.page_seq.value() != expected_occurrence.page_seq()
                || occurrence.commit_seq.value() != expected_occurrence.commit_seq()
            {
                return Err(AdmissionError::FenceMismatch("input occurrence order"));
            }
        }
    }
    for (span, expected) in manifest.cursor_spans.iter().zip(order.cursor_spans()) {
        if span.page_id.to_string() != expected.page_id()
            || span.from_page_seq.value() != expected.from_page_seq()
            || span.to_page_seq.value() != expected.to_page_seq()
        {
            return Err(AdmissionError::FenceMismatch("cursor order"));
        }
    }
    for (gap, expected) in manifest.lossy_gaps.iter().zip(order.lossy_gaps()) {
        let reason = match gap.reason {
            dolly_schema::LossyGapReason::Overflow => "overflow",
            dolly_schema::LossyGapReason::Restart => "restart",
        };
        if gap.page_id.to_string() != expected.page_id()
            || gap.from_page_seq.as_ref().map(|value| value.value()) != expected.from_page_seq()
            || gap.to_page_seq.value() != expected.to_page_seq()
            || reason != expected.reason()
        {
            return Err(AdmissionError::FenceMismatch("lossy order"));
        }
    }
    for (page, expected) in manifest.output_page_ids.iter().zip(order.output_page_ids()) {
        if page.to_string() != expected.as_str() {
            return Err(AdmissionError::FenceMismatch("output order"));
        }
    }
    Ok(())
}

fn validate_replay_scope(
    manifest: &ActivationManifest,
    scope: &ReplayScope,
) -> Result<(), AdmissionError> {
    // The replay contract is selected by the accepted Descriptor in G1. The
    // Manifest's revision and digest are checked here; this check only ensures
    // the premise remains internally coherent before exposing it.
    if manifest.descriptor_revision.value() == 0
        || (scope.mode() == ReplayMode::FencedReplay && scope.evidence() == ReplayEvidence::None)
        || (scope.mode() == ReplayMode::NeverAutoRetry && scope.evidence() != ReplayEvidence::None)
    {
        return Err(AdmissionError::FenceMismatch("replay contract"));
    }
    Ok(())
}

fn require_str<'a>(
    value: &'a serde_json::Value,
    key: &str,
    expected: &str,
) -> Result<&'a str, AdmissionError> {
    let actual = value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .ok_or(AdmissionError::FenceMismatch("durable fence"))?;
    if actual != expected {
        return Err(AdmissionError::FenceMismatch("durable fence"));
    }
    Ok(actual)
}

fn require_i64(value: &serde_json::Value, key: &str, expected: i64) -> Result<(), AdmissionError> {
    if value.get(key).and_then(serde_json::Value::as_i64) != Some(expected) {
        return Err(AdmissionError::FenceMismatch("durable fence"));
    }
    Ok(())
}

fn canonical_value<T: Serialize>(value: &T) -> Result<CanonicalJsonValue, AdmissionError> {
    let (bytes, _) =
        canonicalize(value).map_err(|_| AdmissionError::FenceMismatch("canonical value"))?;
    parse_core_json(bytes.as_bytes(), ParseLimits::protocol_wire())
        .map_err(|_| AdmissionError::FenceMismatch("canonical value"))
}

fn deserialize_canonical<T: DeserializeOwned>(
    value: &CanonicalJsonValue,
) -> Result<T, AdmissionError> {
    T::deserialize(value.clone().into_deserializer())
        .map_err(|_| AdmissionError::FenceMismatch("typed value"))
}

fn canonical_without_field(
    value: &CanonicalJsonValue,
    field: &str,
) -> Result<(dolly_canonical_json::CanonicalBytes, Sha256Digest), AdmissionError> {
    let CanonicalJsonValue::Object(object) = value else {
        return Err(AdmissionError::InvalidFrame("manifest object"));
    };
    let without = CanonicalJsonObject::try_from_iter(
        object
            .iter()
            .filter(|(key, _)| *key != field)
            .map(|(key, value)| (key.to_owned(), value.clone())),
    )
    .map_err(|_| AdmissionError::InvalidFrame("manifest object"))?;
    canonicalize(&without).map_err(|_| AdmissionError::InvalidFrame("manifest digest"))
}

fn decode_canonical_frame(
    frame: &[u8],
    limits: FrameLimits,
) -> Result<CanonicalJsonValue, AdmissionError> {
    decode_message(frame, limits)
        .map(|message| message.body)
        .map_err(|_| AdmissionError::InvalidFrame("frame"))
}

fn frame_nesting_depth(frame: &[u8]) -> u16 {
    let mut depth = 0u16;
    let mut maximum = 0u16;
    let mut index = 0usize;
    while index < frame.len() {
        match frame[index] {
            b'"' => {
                index += 1;
                while index < frame.len() {
                    match frame[index] {
                        b'\\' => index = index.saturating_add(2),
                        b'"' => {
                            index += 1;
                            break;
                        }
                        _ => index += 1,
                    }
                }
            }
            b'{' | b'[' => {
                depth = depth.saturating_add(1);
                maximum = maximum.max(depth);
                index += 1;
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                index += 1;
            }
            _ => index += 1,
        }
    }
    maximum
}

impl Serialize for RpcDirection {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(match self {
            Self::HostToExtension => "host_to_extension",
            Self::ExtensionToHost => "extension_to_host",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn undeclared_capability_is_rejected_without_an_executor() {
        let projection = CapabilityProjection::new(
            "org.example.extension",
            "module",
            DIGEST,
            vec!["host.block.get".into()],
        )
        .unwrap();
        let request = CapabilityRequest::new(
            "org.example.extension",
            "module",
            DIGEST,
            "host.model.invoke",
            RpcDirection::ExtensionToHost,
        )
        .unwrap();
        assert_eq!(
            admit_capability(&projection, &request),
            Err(AdmissionError::CapabilityDenied)
        );
    }

    #[test]
    fn cross_extension_capability_is_rejected_before_any_effect() {
        let projection = CapabilityProjection::new(
            "org.example.extension",
            "module",
            DIGEST,
            vec!["host.block.get".into()],
        )
        .unwrap();
        let request = CapabilityRequest::new(
            "org.other.extension",
            "module",
            DIGEST,
            "host.block.get",
            RpcDirection::ExtensionToHost,
        )
        .unwrap();
        assert_eq!(
            admit_capability(&projection, &request),
            Err(AdmissionError::CapabilityDenied)
        );
    }

    #[test]
    fn reverse_direction_is_rejected_before_any_effect() {
        assert!(
            CapabilityRequest::new(
                "org.example.extension",
                "module",
                DIGEST,
                "host.block.get",
                RpcDirection::HostToExtension,
            )
            .is_err()
        );
    }
}
