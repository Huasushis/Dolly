//! Bounded G1 Runtime transaction engine.
//!
//! The engine is the narrow layer above the accepted WP-004 durable reducer
//! transaction. It validates a frozen Activation Manifest, durably issues one
//! lease, and exposes the canonical dispatch frame only after its started
//! marker commits. It never invokes Extension code or any external effect.

mod host_routes;
mod multimodal;
mod premise;
mod validation;

use dolly_canonical_json::{canonicalize, Sha256Digest};
use dolly_core_domain::{LeaseToken, WorkerEpoch};
use dolly_core_reducer::{
    ActivationState, BuildManifestCommand, CoreCommand, DispatchLeaseCommand, DispatchState,
    EnvironmentInput, IssueLeaseCommand, Transition, TransitionOutcome,
};
use dolly_storage::{ActivationTransaction, SqliteCoreStore, StorageError};
use rusqlite::Connection;
use serde_json::{json, Value};
use thiserror::Error;

pub use dolly_storage::HostConnectionAuthority;
pub use host_routes::{
    AssetHostRoute, ChannelOutboundRoute, ChannelOutboundRunReport, HostRouteError,
    authenticated_channel_event, install_channel_store_schema, open_channel_inbound_route,
    open_channel_inbound_route_with_assets, reconcile_channel_inbound_route,
    reconcile_channel_inbound_route_with_assets, shutdown_asset_routes,
};
pub use multimodal::ProviderAttachmentReader;
pub use premise::{
    CursorSpan, ExecutionDigests, ExecutionFence, ExecutionIdentity, ExecutionOrder,
    ExecutionPremise, InputItemOrder, InputOccurrence, LossyGap, ReplayEvidence, ReplayMode,
    ReplayScope,
};

/// A failure at the G1 validation or durable transaction boundary.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RuntimeError {
    #[error("RUNTIME_MANIFEST_INVALID: {detail}")]
    ManifestInvalid { detail: String },
    #[error("RUNTIME_GRAPH_INVALID: {detail}")]
    GraphInvalid { detail: String },
    #[error("RUNTIME_DESCRIPTOR_INVALID: {detail}")]
    DescriptorInvalid { detail: String },
    #[error("RUNTIME_CONFIG_INVALID: {detail}")]
    ConfigInvalid { detail: String },
    #[error("RUNTIME_REVISION_CONFLICT: {detail}")]
    RevisionConflict { detail: String },
    #[error("RUNTIME_DIGEST_MISMATCH: {detail}")]
    DigestMismatch { detail: String },
    #[error("RUNTIME_DIRECTION_INVALID: {detail}")]
    DirectionInvalid { detail: String },
    #[error("RUNTIME_ORDER_INVALID: {detail}")]
    OrderInvalid { detail: String },
    #[error("RUNTIME_DISPATCH_INVALID: {detail}")]
    DispatchInvalid { detail: String },
    #[error("RUNTIME_REPLAY_INVALID: {detail}")]
    ReplayInvalid { detail: String },
    #[error("RUNTIME_REPLAY_CONFLICT: {detail}")]
    ReplayConflict { detail: String },
    #[error("RUNTIME_GENERATION_INVALID: {detail}")]
    GenerationInvalid { detail: String },
    #[error("RUNTIME_LEASE_UNAVAILABLE: {detail}")]
    LeaseUnavailable { detail: String },
    #[error("RUNTIME_PREMISE_UNAVAILABLE: {detail}")]
    PremiseUnavailable { detail: String },
    #[error("RUNTIME_TRANSACTION_REJECTED: {code}")]
    TransactionRejected { code: String },
    #[error(transparent)]
    Storage(#[from] StorageError),
}

pub type RuntimeResult<T> = Result<T, RuntimeError>;

/// The canonical `module.activate` frame and its committed dispatch transition.
///
/// The frame bytes are returned only after the durable `started` marker commits.
#[derive(Debug, Clone, PartialEq)]
pub struct DispatchResult {
    frame_bytes: Vec<u8>,
    frame_digest: String,
    transition: Transition,
}

impl DispatchResult {
    /// Canonical JSON bytes eligible for the authenticated Extension transport.
    pub fn frame_bytes(&self) -> &[u8] {
        &self.frame_bytes
    }

    /// SHA-256 of the exact canonical frame bytes.
    pub fn frame_digest(&self) -> &str {
        &self.frame_digest
    }

    /// The committed Core transition that authorized the frame.
    pub fn transition(&self) -> &Transition {
        &self.transition
    }
}

/// The caller-owned lease identity and token hash request.
///
/// Worker epoch, connection identity, and request identity are intentionally
/// absent. The Runtime obtains them from verified durable Host connection
/// state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseRequest {
    command_id: String,
    activation_id: String,
    lease_id: String,
    token_digest: String,
    extension_generation: Option<i64>,
}

impl LeaseRequest {
    pub fn new(
        command_id: impl Into<String>,
        activation_id: impl Into<String>,
        lease_id: impl Into<String>,
        token_digest: impl Into<String>,
        extension_generation: Option<i64>,
    ) -> Self {
        Self {
            command_id: command_id.into(),
            activation_id: activation_id.into(),
            lease_id: lease_id.into(),
            token_digest: token_digest.into(),
            extension_generation,
        }
    }
}
/// An opaque reservation allocated by the authenticated Host connection.
///
/// The request identity and its connection binding are private. Only the
/// Runtime can create a reservation, and Core retains its state durably.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestReservation {
    reservation_id: String,
    request_id: String,
    activation_id: String,
    lease_id: String,
    extension_connection_id: String,
    worker_epoch: WorkerEpoch,
    worker_epoch_fence: i64,
    incarnation_revision: i64,
}

/// Typed Host connection identity retained in verified durable Core state.
///
/// This state is the source for lease and request reservation binding; it is
/// never accepted as a dispatch argument.
#[derive(Debug, Clone, PartialEq, Eq)]
struct HostConnectionState {
    extension_connection_id: String,
    worker_epoch: WorkerEpoch,
    worker_epoch_fence: i64,
    incarnation_revision: i64,
}

/// The production G1 transaction façade over one Core writer connection.
///
/// `SqliteCoreStore` remains the only authority that changes durable Core
/// state. This façade has no effect executor and cannot acknowledge an effect.
pub struct RuntimeTransactionEngine<'connection> {
    store: SqliteCoreStore<'connection>,
}

impl<'connection> RuntimeTransactionEngine<'connection> {
    /// Create an engine over the one verified writer connection.
    pub fn new(connection: &'connection mut Connection) -> RuntimeResult<Self> {
        Ok(Self {
            store: SqliteCoreStore::new(connection)?,
        })
    }
    /// Read the verified durable Core snapshot.
    pub fn snapshot(&self) -> RuntimeResult<dolly_core_reducer::CoreSnapshot> {
        Ok(self.store.snapshot()?)
    }

    /// Return the opaque current Host connection authority.
    pub fn host_connection_authority(&self) -> RuntimeResult<HostConnectionAuthority> {
        Ok(self.store.authenticated_host_connection()?)
    }

    /// Bootstrap the durable Host connection state from the accepted lifecycle
    /// configuration. This can only initialize an absent Host state.
    pub fn bootstrap_host_connection(&mut self) -> RuntimeResult<HostConnectionAuthority> {
        Ok(self.store.bootstrap_host_connection()?)
    }

    /// Rotate the durable Host connection using the opaque prior authority.
    pub fn rotate_host_connection(
        &mut self,
        current: &HostConnectionAuthority,
    ) -> RuntimeResult<HostConnectionAuthority> {
        Ok(self.store.rotate_host_connection(current)?)
    }
    /// Allocate one request identity from the current authenticated Host
    /// connection and durably bind it to the requested Activation and lease.
    pub fn allocate_request(
        &mut self,
        request: &LeaseRequest,
        input: &EnvironmentInput,
    ) -> RuntimeResult<RequestReservation> {
        let authority = self.store.authenticated_host_connection()?;
        let transition = self.store.allocate_host_request(
            &authority,
            &request.activation_id,
            &request.lease_id,
            input,
        )?;
        require_committed(&transition)?;
        let reservation_id = transition
            .reply
            .as_ref()
            .and_then(|reply| reply.get("reservation_id"))
            .and_then(Value::as_str)
            .ok_or_else(|| RuntimeError::PremiseUnavailable {
                detail: "request allocation returned no reservation".into(),
            })?;
        request_reservation_from_state(&transition.state, reservation_id)
    }

    /// Accept one immutable Activation Manifest through the WP-004 transaction.
    pub fn accept_manifest(
        &mut self,
        command: &BuildManifestCommand,
        input: &EnvironmentInput,
    ) -> RuntimeResult<Transition> {
        if command.command_id.is_empty() || command.activation_id.is_empty() {
            return Err(RuntimeError::ManifestInvalid {
                detail: "command_id and activation_id are required".into(),
            });
        }
        let (submitted_manifest, _) = validation::validate_manifest_for_replay(&command.manifest)?;
        if submitted_manifest.activation_id.to_string() != command.activation_id {
            return Err(RuntimeError::ReplayConflict {
                detail: "Manifest activation_id does not match the transaction identity".into(),
            });
        }
        let snapshot = self.store.snapshot()?;
        if let Some(existing) = snapshot.manifests.get(&command.activation_id) {
            let (existing_manifest, _) = validation::validate_manifest_for_replay(existing)?;
            if !same_canonical(&existing_manifest, &submitted_manifest)? {
                return Err(RuntimeError::ReplayConflict {
                    detail: "Activation Manifest identity already has different bytes".into(),
                });
            }
        } else {
            validation::validate_manifest_against_snapshot(
                &command.manifest,
                &snapshot,
                input,
                command.expected_graph_revision,
                command.expected_descriptor_revision,
            )?;
        }
        let transition = self
            .store
            .transact(&CoreCommand::BuildManifest(command.clone()), input)?;
        require_committed(&transition)?;
        let retained = transition
            .state
            .manifests
            .get(&command.activation_id)
            .ok_or_else(|| RuntimeError::PremiseUnavailable {
                detail: "committed Manifest is absent from the durable state".into(),
            })?;
        if !same_canonical(retained, &command.manifest)? {
            return Err(RuntimeError::ReplayConflict {
                detail: "durable Manifest differs from the submitted bytes".into(),
            });
        }
        Ok(transition)
    }

    /// Durably issue one lease and return the bounded execution premise.
    ///
    /// No frame is written, no process is called, and no external effect is
    /// admitted. An exact replay returns the premise from the retained lease.
    pub fn prepare_execution(
        &mut self,
        request: &LeaseRequest,
        reservation: &RequestReservation,
        input: &EnvironmentInput,
    ) -> RuntimeResult<ExecutionPremise> {
        let snapshot = self.store.snapshot()?;
        let connection = host_connection_state(&snapshot)?;
        validate_request_reservation(&snapshot, &connection, request, reservation)?;
        let command = IssueLeaseCommand {
            command_id: request.command_id.clone(),
            activation_id: request.activation_id.clone(),
            lease_id: request.lease_id.clone(),
            token_digest: request.token_digest.clone(),
            extension_connection_id: reservation.extension_connection_id.clone(),
            reservation_id: Some(reservation.reservation_id.clone()),
            request_id: Some(reservation.request_id.clone()),
            worker_epoch: reservation.worker_epoch_fence,
            worker_epoch_id: Some(reservation.worker_epoch.to_string()),
            incarnation_revision: Some(reservation.incarnation_revision),
            extension_generation: request.extension_generation,
        };
        validate_lease_request(&command)?;
        let activation = snapshot
            .activations
            .get(&command.activation_id)
            .ok_or_else(|| RuntimeError::LeaseUnavailable {
                detail: "Activation is not present in durable state".into(),
            })?;
        let manifest_value = activation
            .manifest
            .as_ref()
            .or_else(|| snapshot.manifests.get(&command.activation_id))
            .ok_or_else(|| RuntimeError::LeaseUnavailable {
                detail: "Activation has no retained Manifest".into(),
            })?;
        let (manifest, _) = validation::validate_manifest_for_replay(manifest_value)?;
        if manifest.activation_id.to_string() != command.activation_id {
            return Err(RuntimeError::ReplayConflict {
                detail: "lease Activation identity does not match retained Manifest".into(),
            });
        }
        let validated = validation::validate_manifest_against_snapshot(
            manifest_value,
            &snapshot,
            input,
            Some(manifest.graph_revision.value() as i64),
            Some(manifest.descriptor_revision.value() as i64),
        )?;
        validate_generation(&snapshot, command.extension_generation)?;
        validate_existing_lease_or_state(&snapshot, &command, activation.state)?;

        let transition = self
            .store
            .transact(&CoreCommand::IssueLease(command.clone()), input)?;
        require_committed(&transition)?;
        build_premise(&transition.state, &command, validated)
    }

    /// Build the exact canonical `module.activate` frame and durably mark it
    /// `started`. The frame is returned only after the marker commits.
    ///
    /// `premise` must be the result of `prepare_execution`. The typed
    /// WorkerEpoch, connection identity, and request identity come from the
    /// verified current Host state and are rechecked against the retained
    /// lease. This method never writes transport bytes or invokes Extension
    /// code.
    pub fn dispatch_execution(
        &mut self,
        premise: &ExecutionPremise,
        dispatch_command_id: &str,
        lease_token: &LeaseToken,
        input: &EnvironmentInput,
    ) -> RuntimeResult<DispatchResult> {
        if dispatch_command_id.is_empty() {
            return Err(RuntimeError::DispatchInvalid {
                detail: "dispatch command_id is required".into(),
            });
        }

        let snapshot = self.store.snapshot()?;
        let connection = host_connection_state(&snapshot)?;
        if connection.extension_connection_id != premise.fence().extension_connection_id()
            || connection.worker_epoch != *premise.fence().worker_epoch()
            || connection.worker_epoch_fence != premise.fence().worker_epoch_fence()
            || connection.incarnation_revision != premise.fence().incarnation_revision()
        {
            return Err(RuntimeError::PremiseUnavailable {
                detail: "current Host connection no longer owns the prepared WorkerEpoch".into(),
            });
        }
        let manifest_value = retained_manifest_for_dispatch(&snapshot, premise, lease_token)?;
        let (manifest, _) = validation::validate_manifest_for_replay(&manifest_value)?;
        let frame = json!({
            "jsonrpc": "2.0",
            "id": premise.fence().request_id(),
            "method": "module.activate",
            "params": {
                "worker_epoch": premise.fence().worker_epoch(),
                "extension_generation": premise.fence().extension_generation(),
                "lease_generation": premise.fence().lease_generation(),
                "lease_token": lease_token.expose_base64url(),
                "attempt": premise.fence().attempt(),
                "manifest": manifest_value,
            }
        });
        let (frame_bytes, frame_digest) = canonicalize(&frame)
            .map_err(|error| RuntimeError::DispatchInvalid {
                detail: format!("cannot canonicalize module.activate frame: {error}"),
            })
            .map(|(bytes, digest)| (bytes.into_vec(), digest.to_canonical_string()))?;
        let frame_size =
            u64::try_from(frame_bytes.len()).map_err(|_| RuntimeError::DispatchInvalid {
                detail: "module.activate frame size exceeds u64".into(),
            })?;
        if frame_size > manifest.required_frame_bytes {
            return Err(RuntimeError::DispatchInvalid {
                detail: format!(
                    "module.activate frame is {frame_size} bytes but Manifest permits {}",
                    manifest.required_frame_bytes
                ),
            });
        }
        let frame_depth = frame_nesting_depth(&frame);
        if frame_depth > manifest.required_frame_nesting_depth {
            return Err(RuntimeError::DispatchInvalid {
                detail: format!(
                    "module.activate frame depth is {frame_depth} but Manifest permits {}",
                    manifest.required_frame_nesting_depth
                ),
            });
        }

        let transition = self.store.transact(
            &CoreCommand::DispatchLease(DispatchLeaseCommand {
                command_id: dispatch_command_id.into(),
                activation_id: premise.identity().activation_id().into(),
                lease_id: premise.fence().lease_id().into(),
                dispatch_state: DispatchState::Started,
                reservation_id: Some(premise.fence().reservation_id().into()),
                request_id: Some(premise.fence().request_id().into()),
                incarnation_revision: Some(premise.fence().incarnation_revision()),
                extension_connection_id: Some(premise.fence().extension_connection_id().into()),
                frame_digest: Some(frame_digest.clone()),
            }),
            input,
        )?;
        require_committed(&transition)?;
        let committed_lease = transition
            .state
            .leases
            .get(premise.fence().lease_id())
            .ok_or_else(|| RuntimeError::PremiseUnavailable {
                detail: "committed dispatch lease is absent".into(),
            })?;
        let committed_digest = committed_lease
            .get("frame_digest")
            .and_then(Value::as_str);
        let committed_reservation_id = committed_lease
            .get("reservation_id")
            .and_then(Value::as_str);
        let committed_request_id = committed_lease
            .get("request_id")
            .and_then(Value::as_str);
        let committed_connection_id = committed_lease
            .get("extension_connection_id")
            .and_then(Value::as_str);
        let committed_state = transition
            .state
            .activations
            .get(premise.identity().activation_id())
            .map(|activation| activation.state);
        if committed_state != Some(ActivationState::Dispatched)
            || committed_digest != Some(frame_digest.as_str())
            || committed_request_id != Some(premise.fence().request_id())
            || committed_connection_id != Some(premise.fence().extension_connection_id())
            || committed_reservation_id != Some(premise.fence().reservation_id())
        {
            return Err(RuntimeError::PremiseUnavailable {
                detail: "committed dispatch does not retain the exact request binding".into(),
            });
        }
        Ok(DispatchResult {
            frame_bytes,
            frame_digest,
            transition,
        })
    }

}

// ---------------------------------------------------------------------------
// One-transaction activation stages.
//
// Each stage reduces and persists exactly one Core command inside the
// supplied `ActivationTransaction`. Together they form the whole request (Host
// grant validation, manifest acceptance, request allocation, lease issue,
// dispatch/journal, and final G2 admission) under one SQLite commit, so a
// process kill at any stage rolls the request back completely.
// ---------------------------------------------------------------------------

/// Validate and persist the accepted Activation Manifest as the first
/// request-owned stage.
pub fn activation_stage_manifest(
    transaction: &mut ActivationTransaction<'_>,
    build: &BuildManifestCommand,
    input: &EnvironmentInput,
) -> RuntimeResult<Transition> {
    if build.command_id.is_empty() || build.activation_id.is_empty() {
        return Err(RuntimeError::ManifestInvalid {
            detail: "command_id and activation_id are required".into(),
        });
    }
    let (submitted_manifest, _) = validation::validate_manifest_for_replay(&build.manifest)?;
    if submitted_manifest.activation_id.to_string() != build.activation_id {
        return Err(RuntimeError::ReplayConflict {
            detail: "Manifest activation_id does not match the transaction identity".into(),
        });
    }
    let snapshot = transaction.snapshot()?;
    if let Some(existing) = snapshot.manifests.get(&build.activation_id) {
        let (existing_manifest, _) = validation::validate_manifest_for_replay(existing)?;
        if !same_canonical(&existing_manifest, &submitted_manifest)? {
            return Err(RuntimeError::ReplayConflict {
                detail: "Activation Manifest identity already has different bytes".into(),
            });
        }
    } else {
        validation::validate_manifest_against_snapshot(
            &build.manifest,
            &snapshot,
            input,
            build.expected_graph_revision,
            build.expected_descriptor_revision,
        )?;
    }
    let transition =
        transaction.apply(&CoreCommand::BuildManifest(build.clone()), input)?;
    require_committed(&transition)?;
    let retained = transition
        .state
        .manifests
        .get(&build.activation_id)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "committed Manifest is absent from the durable state".into(),
        })?;
    if !same_canonical(retained, &build.manifest)? {
        return Err(RuntimeError::ReplayConflict {
            detail: "durable Manifest differs from the submitted bytes".into(),
        });
    }
    Ok(transition)
}

/// Allocate the Host request reservation as the second request-owned stage.
pub fn activation_stage_allocation(
    transaction: &mut ActivationTransaction<'_>,
    authority: &HostConnectionAuthority,
    activation_id: &str,
    lease_id: &str,
    input: &EnvironmentInput,
) -> RuntimeResult<RequestReservation> {
    let snapshot = transaction.snapshot()?;
    let command =
        dolly_storage::host_request_allocation_command(&snapshot, authority, activation_id, lease_id)?;
    let command_id = command.command_id().to_owned();
    let transition = dolly_storage::allocate_host_request_transition(
        &snapshot,
        &command_id,
        authority,
        activation_id,
        lease_id,
        input,
    )?;
    let transition = transaction.apply_with_transition(&command, input, transition)?;
    require_committed(&transition)?;
    let reservation_id = transition
        .reply
        .as_ref()
        .and_then(|reply| reply.get("reservation_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "request allocation returned no reservation".into(),
        })?;
    request_reservation_from_state(&transition.state, reservation_id)
}

/// Issue the lease and build the exact Runtime premise as the third stage.
pub fn activation_stage_lease(
    transaction: &mut ActivationTransaction<'_>,
    request: &LeaseRequest,
    reservation: &RequestReservation,
    input: &EnvironmentInput,
) -> RuntimeResult<(ExecutionPremise, Transition)> {
    let snapshot = transaction.snapshot()?;
    let connection = host_connection_state(&snapshot)?;
    validate_request_reservation(&snapshot, &connection, request, reservation)?;
    let command = IssueLeaseCommand {
        command_id: request.command_id.clone(),
        activation_id: request.activation_id.clone(),
        lease_id: request.lease_id.clone(),
        token_digest: request.token_digest.clone(),
        extension_connection_id: reservation.extension_connection_id.clone(),
        reservation_id: Some(reservation.reservation_id.clone()),
        request_id: Some(reservation.request_id.clone()),
        worker_epoch: reservation.worker_epoch_fence,
        worker_epoch_id: Some(reservation.worker_epoch.to_string()),
        incarnation_revision: Some(reservation.incarnation_revision),
        extension_generation: request.extension_generation,
    };
    validate_lease_request(&command)?;
    let activation = snapshot
        .activations
        .get(&command.activation_id)
        .ok_or_else(|| RuntimeError::LeaseUnavailable {
            detail: "Activation is not present in durable state".into(),
        })?;
    let manifest_value = activation
        .manifest
        .as_ref()
        .or_else(|| snapshot.manifests.get(&command.activation_id))
        .ok_or_else(|| RuntimeError::LeaseUnavailable {
            detail: "Activation has no retained Manifest".into(),
        })?;
    let (manifest, _) = validation::validate_manifest_for_replay(manifest_value)?;
    if manifest.activation_id.to_string() != command.activation_id {
        return Err(RuntimeError::ReplayConflict {
            detail: "lease Activation identity does not match retained Manifest".into(),
        });
    }
    let validated = validation::validate_manifest_against_snapshot(
        manifest_value,
        &snapshot,
        input,
        Some(manifest.graph_revision.value() as i64),
        Some(manifest.descriptor_revision.value() as i64),
    )?;
    validate_generation(&snapshot, command.extension_generation)?;
    validate_existing_lease_or_state(&snapshot, &command, activation.state)?;
    let transition = transaction.apply(&CoreCommand::IssueLease(command.clone()), input)?;
    require_committed(&transition)?;
    let premise = build_premise(&transition.state, &command, validated)?;
    Ok((premise, transition))
}

/// Build and persist the canonical `module.activate` dispatch marker as the
/// fourth request-owned stage.
pub fn activation_stage_dispatch(
    transaction: &mut ActivationTransaction<'_>,
    premise: &ExecutionPremise,
    dispatch_command_id: &str,
    lease_token: &LeaseToken,
    input: &EnvironmentInput,
) -> RuntimeResult<DispatchResult> {
    if dispatch_command_id.is_empty() {
        return Err(RuntimeError::DispatchInvalid {
            detail: "dispatch command_id is required".into(),
        });
    }
    let snapshot = transaction.snapshot()?;
    let connection = host_connection_state(&snapshot)?;
    if connection.extension_connection_id != premise.fence().extension_connection_id()
        || connection.worker_epoch != *premise.fence().worker_epoch()
        || connection.worker_epoch_fence != premise.fence().worker_epoch_fence()
        || connection.incarnation_revision != premise.fence().incarnation_revision()
    {
        return Err(RuntimeError::PremiseUnavailable {
            detail: "current Host connection no longer owns the prepared WorkerEpoch".into(),
        });
    }
    let manifest_value = retained_manifest_for_dispatch(&snapshot, premise, lease_token)?;
    let (manifest, _) = validation::validate_manifest_for_replay(&manifest_value)?;
    let frame = json!({
        "jsonrpc": "2.0",
        "id": premise.fence().request_id(),
        "method": "module.activate",
        "params": {
            "worker_epoch": premise.fence().worker_epoch(),
            "extension_generation": premise.fence().extension_generation(),
            "lease_generation": premise.fence().lease_generation(),
            "lease_token": lease_token.expose_base64url(),
            "attempt": premise.fence().attempt(),
            "manifest": manifest_value,
        }
    });
    let (frame_bytes, frame_digest) = canonicalize(&frame)
        .map_err(|error| RuntimeError::DispatchInvalid {
            detail: format!("cannot canonicalize module.activate frame: {error}"),
        })
        .map(|(bytes, digest)| (bytes.into_vec(), digest.to_canonical_string()))?;
    let frame_size =
        u64::try_from(frame_bytes.len()).map_err(|_| RuntimeError::DispatchInvalid {
            detail: "module.activate frame size exceeds u64".into(),
        })?;
    if frame_size > manifest.required_frame_bytes {
        return Err(RuntimeError::DispatchInvalid {
            detail: format!(
                "module.activate frame is {frame_size} bytes but Manifest permits {}",
                manifest.required_frame_bytes
            ),
        });
    }
    let frame_depth = frame_nesting_depth(&frame);
    if frame_depth > manifest.required_frame_nesting_depth {
        return Err(RuntimeError::DispatchInvalid {
            detail: format!(
                "module.activate frame depth is {frame_depth} but Manifest permits {}",
                manifest.required_frame_nesting_depth
            ),
        });
    }
    let transition = transaction.apply(
        &CoreCommand::DispatchLease(DispatchLeaseCommand {
            command_id: dispatch_command_id.into(),
            activation_id: premise.identity().activation_id().into(),
            lease_id: premise.fence().lease_id().into(),
            dispatch_state: DispatchState::Started,
            reservation_id: Some(premise.fence().reservation_id().into()),
            request_id: Some(premise.fence().request_id().into()),
            incarnation_revision: Some(premise.fence().incarnation_revision()),
            extension_connection_id: Some(premise.fence().extension_connection_id().into()),
            frame_digest: Some(frame_digest.clone()),
        }),
        input,
    )?;
    require_committed(&transition)?;
    let committed_lease = transition
        .state
        .leases
        .get(premise.fence().lease_id())
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "committed dispatch lease is absent".into(),
        })?;
    let committed_digest = committed_lease
        .get("frame_digest")
        .and_then(Value::as_str);
    let committed_reservation_id = committed_lease
        .get("reservation_id")
        .and_then(Value::as_str);
    let committed_request_id = committed_lease
        .get("request_id")
        .and_then(Value::as_str);
    let committed_connection_id = committed_lease
        .get("extension_connection_id")
        .and_then(Value::as_str);
    let committed_state = transition
        .state
        .activations
        .get(premise.identity().activation_id())
        .map(|activation| activation.state);
    if committed_state != Some(ActivationState::Dispatched)
        || committed_digest != Some(frame_digest.as_str())
        || committed_request_id != Some(premise.fence().request_id())
        || committed_connection_id != Some(premise.fence().extension_connection_id())
        || committed_reservation_id != Some(premise.fence().reservation_id())
    {
        return Err(RuntimeError::PremiseUnavailable {
            detail: "committed dispatch does not retain the exact request binding".into(),
        });
    }
    Ok(DispatchResult {
        frame_bytes,
        frame_digest,
        transition,
    })
}

fn host_connection_state(
    snapshot: &dolly_core_reducer::CoreSnapshot,
) -> RuntimeResult<HostConnectionState> {
    let record = snapshot
        .host_connection
        .as_ref()
        .ok_or_else(|| RuntimeError::GenerationInvalid {
            detail: "verified Host connection state is absent".into(),
        })?;
    if record.incarnation_revision <= 0
        || !snapshot.host_connection_history.contains(&record.identity)
    {
        return Err(RuntimeError::GenerationInvalid {
            detail: "verified Host connection state is invalid".into(),
        });
    }
    let extension_connection_id = record.identity.extension_connection_id.clone();
    if extension_connection_id.is_empty() {
        return Err(RuntimeError::GenerationInvalid {
            detail: "verified Host connection id is absent".into(),
        });
    }
    let worker_epoch = record
        .identity
        .worker_epoch_id
        .parse::<WorkerEpoch>()
        .map_err(|error| RuntimeError::GenerationInvalid {
            detail: format!("verified Host WorkerEpoch is invalid: {error}"),
        })?;
    if record.identity.worker_epoch_fence <= 0 {
        return Err(RuntimeError::GenerationInvalid {
            detail: "verified Host WorkerEpoch fence is absent or invalid".into(),
        });
    }
    Ok(HostConnectionState {
        extension_connection_id,
        worker_epoch,
        worker_epoch_fence: record.identity.worker_epoch_fence,
        incarnation_revision: record.incarnation_revision,
    })
}
fn validate_request_id(value: &str) -> RuntimeResult<()> {
    if value.is_empty() || value.len() > 128 || value.contains('\0') {
        return Err(RuntimeError::DispatchInvalid {
            detail: "request identity must be non-empty valid UTF-8 and at most 128 bytes"
                .into(),
        });
    }
    Ok(())
}
fn request_reservation_from_state(
    snapshot: &dolly_core_reducer::CoreSnapshot,
    reservation_id: &str,
) -> RuntimeResult<RequestReservation> {
    let record = snapshot
        .host_request_reservations
        .get(reservation_id)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "request reservation is absent from durable Host state".into(),
        })?;
    if record.get("state").and_then(Value::as_str) != Some("bound") {
        return Err(RuntimeError::PremiseUnavailable {
            detail: "request reservation is not outstanding".into(),
        });
    }
    let request_id = record
        .get("request_id")
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "request reservation has no request identity".into(),
        })?;
    validate_request_id(request_id)?;
    let activation_id = record
        .get("activation_id")
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "request reservation has no Activation binding".into(),
        })?;
    let lease_id = record
        .get("lease_id")
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "request reservation has no lease binding".into(),
        })?;
    let extension_connection_id = record
        .get("extension_connection_id")
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "request reservation has no connection binding".into(),
        })?;
    let worker_epoch_id = record
        .get("worker_epoch_id")
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "request reservation has no typed WorkerEpoch".into(),
        })?;
    let worker_epoch = worker_epoch_id
        .parse::<WorkerEpoch>()
        .map_err(|error| RuntimeError::PremiseUnavailable {
            detail: format!("request reservation WorkerEpoch is invalid: {error}"),
        })?;
    let worker_epoch_fence = record
        .get("worker_epoch")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "request reservation WorkerEpoch fence is invalid".into(),
        })?;
    let incarnation_revision = record
        .get("incarnation_revision")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "request reservation has no Host incarnation revision".into(),
        })?;
    Ok(RequestReservation {
        reservation_id: reservation_id.into(),
        request_id: request_id.into(),
        activation_id: activation_id.into(),
        lease_id: lease_id.into(),
        extension_connection_id: extension_connection_id.into(),
        worker_epoch,
        worker_epoch_fence,
        incarnation_revision,
    })
}
fn validate_request_reservation(
    snapshot: &dolly_core_reducer::CoreSnapshot,
    connection: &HostConnectionState,
    request: &LeaseRequest,
    reservation: &RequestReservation,
) -> RuntimeResult<()> {
    if reservation.activation_id != request.activation_id || reservation.lease_id != request.lease_id
    {
        return Err(RuntimeError::ReplayConflict {
            detail: "request reservation is bound to a different lease".into(),
        });
    }
    if reservation.extension_connection_id != connection.extension_connection_id
        || reservation.worker_epoch != connection.worker_epoch
        || reservation.worker_epoch_fence != connection.worker_epoch_fence
        || reservation.incarnation_revision != connection.incarnation_revision
    {
        return Err(RuntimeError::PremiseUnavailable {
            detail: "current Host connection no longer owns the request reservation".into(),
        });
    }
    let durable = request_reservation_from_state(snapshot, &reservation.reservation_id)?;
    if durable != *reservation {
        return Err(RuntimeError::ReplayConflict {
            detail: "request reservation differs from durable Host state".into(),
        });
    }
    Ok(())
}

fn retained_manifest_for_dispatch(
    snapshot: &dolly_core_reducer::CoreSnapshot,
    premise: &ExecutionPremise,
    lease_token: &LeaseToken,
) -> RuntimeResult<Value> {
    let activation = snapshot
        .activations
        .get(premise.identity().activation_id())
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "dispatch Activation is absent from durable state".into(),
        })?;
    if !matches!(
        activation.state,
        ActivationState::Leased | ActivationState::Dispatched
    ) {
        return Err(RuntimeError::PremiseUnavailable {
            detail: "dispatch Activation is no longer leased or dispatched".into(),
        });
    }
    let manifest = activation
        .manifest
        .as_ref()
        .or_else(|| snapshot.manifests.get(premise.identity().activation_id()))
        .cloned()
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "dispatch Activation has no retained Manifest".into(),
        })?;
    let (typed_manifest, _) = validation::validate_manifest_for_replay(&manifest)?;
    if typed_manifest.activation_id.to_string() != premise.identity().activation_id()
        || typed_manifest.module_id.to_string() != premise.identity().module_id()
        || typed_manifest.manifest_digest.to_string() != premise.digests().manifest_digest()
    {
        return Err(RuntimeError::ReplayConflict {
            detail: "dispatch premise does not bind the retained Manifest".into(),
        });
    }
    let lease = snapshot
        .leases
        .get(premise.fence().lease_id())
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "dispatch lease is absent from durable state".into(),
        })?;
    let reservation =
        request_reservation_from_state(snapshot, premise.fence().reservation_id())?;
    if reservation.activation_id != premise.identity().activation_id()
        || reservation.lease_id != premise.fence().lease_id()
        || reservation.request_id != premise.fence().request_id()
        || reservation.extension_connection_id
            != premise.fence().extension_connection_id()
        || reservation.incarnation_revision != premise.fence().incarnation_revision()
    {
        return Err(RuntimeError::PremiseUnavailable {
            detail: "dispatch reservation binding differs from the premise".into(),
        });
    }
    let token_digest = Sha256Digest::compute(lease_token.expose_bytes()).to_canonical_string();
    if lease.get("activation_id").and_then(Value::as_str)
        != Some(premise.identity().activation_id())
        || lease.get("attempt").and_then(Value::as_i64) != Some(premise.fence().attempt())
        || lease.get("worker_epoch").and_then(Value::as_i64)
            != Some(premise.fence().worker_epoch_fence())
        || lease.get("worker_epoch_id").and_then(Value::as_str)
            != Some(premise.fence().worker_epoch().to_string().as_str())
        || lease.get("incarnation_revision").and_then(Value::as_i64)
            != Some(premise.fence().incarnation_revision())
        || lease.get("reservation_id").and_then(Value::as_str)
            != Some(premise.fence().reservation_id())
        || lease.get("request_id").and_then(Value::as_str) != Some(premise.fence().request_id())
        || lease.get("extension_generation").and_then(Value::as_i64)
            != Some(premise.fence().extension_generation())
        || lease.get("extension_connection_id").and_then(Value::as_str)
            != Some(premise.fence().extension_connection_id())
        || lease.get("token_digest").and_then(Value::as_str) != Some(token_digest.as_str())
        || !matches!(
            lease.get("dispatch_state").and_then(Value::as_str),
            Some("prepared" | "started")
        )
    {
        return Err(RuntimeError::PremiseUnavailable {
            detail: "dispatch lease fences do not match the Runtime premise".into(),
        });
    }
    Ok(manifest)
}

fn frame_nesting_depth(value: &Value) -> u16 {
    match value {
        Value::Array(values) => {
            1u16.saturating_add(values.iter().map(frame_nesting_depth).max().unwrap_or(0))
        }
        Value::Object(values) => {
            1u16.saturating_add(values.values().map(frame_nesting_depth).max().unwrap_or(0))
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => 0,
    }
}

fn same_canonical<T: serde::Serialize, U: serde::Serialize>(
    left: &T,
    right: &U,
) -> RuntimeResult<bool> {
    let left = dolly_canonical_json::canonicalize(left)
        .map_err(|error| RuntimeError::ManifestInvalid {
            detail: format!("cannot canonicalize retained Manifest: {error}"),
        })?
        .0;
    let right = dolly_canonical_json::canonicalize(right)
        .map_err(|error| RuntimeError::ManifestInvalid {
            detail: format!("cannot canonicalize submitted Manifest: {error}"),
        })?
        .0;
    Ok(left.as_bytes() == right.as_bytes())
}

fn require_committed(transition: &Transition) -> RuntimeResult<()> {
    if transition.outcome == TransitionOutcome::Committed {
        return Ok(());
    }
    Err(validation::map_reducer_failure(transition))
}

fn validate_lease_request(command: &IssueLeaseCommand) -> RuntimeResult<()> {
    if command.command_id.is_empty()
        || command.activation_id.is_empty()
        || command.lease_id.is_empty()
        || command.extension_connection_id.is_empty()
    {
        return Err(RuntimeError::LeaseUnavailable {
            detail: "command and lease identities are required".into(),
        });
    }
    let incarnation_revision = command
        .incarnation_revision
        .filter(|value| *value > 0)
        .ok_or_else(|| RuntimeError::GenerationInvalid {
            detail: "Host incarnation revision is required for a Runtime lease".into(),
        })?;
    if incarnation_revision <= 0 {
        return Err(RuntimeError::GenerationInvalid {
            detail: "Host incarnation revision must be positive".into(),
        });
    }
    if command.worker_epoch <= 0 {
        return Err(RuntimeError::GenerationInvalid {
            detail: "worker_epoch fence must be positive".into(),
        });
    }
    let _reservation_id = command
        .reservation_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RuntimeError::DispatchInvalid {
            detail: "Host request reservation is required for a Runtime lease".into(),
        })?;
    let request_id = command
        .request_id
        .as_deref()
        .ok_or_else(|| RuntimeError::DispatchInvalid {
            detail: "Host request identity is required for a Runtime lease".into(),
        })?;
    validate_request_id(request_id)?;
    let worker_epoch_id = command
        .worker_epoch_id
        .as_deref()
        .ok_or_else(|| RuntimeError::GenerationInvalid {
            detail: "typed WorkerEpoch is required for a Runtime lease".into(),
        })?;
    worker_epoch_id
        .parse::<WorkerEpoch>()
        .map_err(|error| RuntimeError::GenerationInvalid {
            detail: format!("typed WorkerEpoch is invalid: {error}"),
        })?;
    let generation =
        command
            .extension_generation
            .ok_or_else(|| RuntimeError::GenerationInvalid {
                detail: "extension_generation is required for a premise".into(),
            })?;
    if generation <= 0 {
        return Err(RuntimeError::GenerationInvalid {
            detail: "extension_generation must be positive".into(),
        });
    }
    command
        .token_digest
        .parse::<dolly_canonical_json::Sha256Digest>()
        .map_err(|_| RuntimeError::DigestMismatch {
            detail: "lease token_digest is not canonical SHA-256".into(),
        })?;
    Ok(())
}

fn validate_generation(
    snapshot: &dolly_core_reducer::CoreSnapshot,
    requested: Option<i64>,
) -> RuntimeResult<()> {
    let requested = requested.ok_or_else(|| RuntimeError::GenerationInvalid {
        detail: "extension_generation is required for a premise".into(),
    })?;
    if snapshot.generations.is_empty() {
        return Ok(());
    }
    if snapshot.generations.iter().any(|candidate| {
        candidate.get("generation").and_then(Value::as_i64) == Some(requested)
            && candidate.get("compatible").and_then(Value::as_bool) != Some(false)
    }) {
        Ok(())
    } else {
        Err(RuntimeError::GenerationInvalid {
            detail: "requested Extension generation is not a compatible durable candidate".into(),
        })
    }
}

fn validate_existing_lease_or_state(
    snapshot: &dolly_core_reducer::CoreSnapshot,
    command: &IssueLeaseCommand,
    state: ActivationState,
) -> RuntimeResult<()> {
    if let Some(existing) = snapshot.leases.get(&command.lease_id) {
        let exact = existing.get("activation_id").and_then(Value::as_str)
            == Some(command.activation_id.as_str())
            && existing.get("token_digest").and_then(Value::as_str)
                == Some(command.token_digest.as_str())
            && existing
                .get("extension_connection_id")
                .and_then(Value::as_str)
                == Some(command.extension_connection_id.as_str())
            && existing.get("worker_epoch").and_then(Value::as_i64) == Some(command.worker_epoch)
            && existing.get("worker_epoch_id").and_then(Value::as_str)
                == command.worker_epoch_id.as_deref()
            && existing.get("incarnation_revision").and_then(Value::as_i64)
                == command.incarnation_revision
            && existing.get("request_id").and_then(Value::as_str)
                == command.request_id.as_deref()
            && existing.get("reservation_id").and_then(Value::as_str)
                == command.reservation_id.as_deref()
            && existing.get("requested_extension_generation")
                == Some(&json!(command.extension_generation));
        if exact {
            return Ok(());
        }
        return Err(RuntimeError::ReplayConflict {
            detail: "retained lease has different fence data".into(),
        });
    }
    if matches!(state, ActivationState::Ready | ActivationState::RetryWait) {
        Ok(())
    } else {
        Err(RuntimeError::LeaseUnavailable {
            detail: "Activation is not ready for a new lease".into(),
        })
    }
}

fn build_premise(
    state: &dolly_core_reducer::CoreSnapshot,
    command: &IssueLeaseCommand,
    validated: validation::ValidatedManifest,
) -> RuntimeResult<ExecutionPremise> {
    let activation = state
        .activations
        .get(&command.activation_id)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "committed lease has no Activation".into(),
        })?;
    if activation.state != ActivationState::Leased {
        return Err(RuntimeError::PremiseUnavailable {
            detail: "committed lease did not leave Activation leased".into(),
        });
    }
    let lease =
        state
            .leases
            .get(&command.lease_id)
            .ok_or_else(|| RuntimeError::PremiseUnavailable {
                detail: "committed lease is absent".into(),
            })?;
    let manifest_digest = validated.manifest.manifest_digest.to_string();
    if lease.get("activation_id").and_then(Value::as_str)
        != Some(command.activation_id.as_str())
        || lease.get("dispatch_state").and_then(Value::as_str) != Some("prepared")
        || lease.get("manifest_digest").and_then(Value::as_str)
            != Some(manifest_digest.as_str())
    {
        return Err(RuntimeError::PremiseUnavailable {
            detail: "committed lease does not bind the retained Manifest and prepared state".into(),
        });
    }
    let reservation_id = lease
        .get("reservation_id")
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "committed lease has no request reservation".into(),
        })?
        .to_owned();
    let request_id = lease
        .get("request_id")
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "committed lease has no request identity".into(),
        })?
        .to_owned();
    validate_request_id(&request_id)?;
    let worker_epoch_fence = lease
        .get("worker_epoch")
        .and_then(Value::as_i64)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "committed lease has no Worker epoch fence".into(),
        })?;
    let incarnation_revision = lease
        .get("incarnation_revision")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "committed lease has no Host incarnation revision".into(),
        })?;
    let worker_epoch = lease
        .get("worker_epoch_id")
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "committed lease has no typed WorkerEpoch".into(),
        })?
        .parse::<WorkerEpoch>()
        .map_err(|error| RuntimeError::GenerationInvalid {
            detail: format!("committed lease WorkerEpoch is invalid: {error}"),
        })?;
    let extension_generation = lease
        .get("extension_generation")
        .and_then(Value::as_i64)
        .ok_or_else(|| RuntimeError::GenerationInvalid {
            detail: "committed lease has no Extension generation".into(),
        })?;
    let attempt = lease
        .get("attempt")
        .and_then(Value::as_i64)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "committed lease has no attempt fence".into(),
        })?;
    if attempt <= 0
        || worker_epoch_fence != command.worker_epoch
        || command.worker_epoch_id.as_deref() != Some(worker_epoch.to_string().as_str())
        || command.incarnation_revision != Some(incarnation_revision)
        || extension_generation != command.extension_generation.unwrap_or_default()
        || command.request_id.as_deref() != Some(request_id.as_str())
        || command.reservation_id.as_deref() != Some(reservation_id.as_str())
    {
        return Err(RuntimeError::GenerationInvalid {
            detail: "committed lease fence disagrees with the request".into(),
        });
    }
    let extension_connection_id = lease
        .get("extension_connection_id")
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "committed lease has no Extension connection".into(),
        })?;
    Ok(ExecutionPremise::new(
        ExecutionIdentity::new(
            validated.manifest.activation_id.to_string(),
            validated.manifest.module_id.to_string(),
        ),
        ExecutionFence::new(
            command.lease_id.clone(),
            reservation_id,
            request_id,
            worker_epoch,
            worker_epoch_fence,
            incarnation_revision,
            extension_generation,
            attempt,
            extension_connection_id.to_owned(),
        ),
        ExecutionDigests::new(
            validated.graph_digest,
            validated.descriptor_digest,
            manifest_digest,
            validated.manifest.effective_config_digest.to_string(),
            validated
                .manifest
                .effective_config_schema_digest
                .to_string(),
        ),
        validated.order,
        validated.replay_scope,
    ))
}

#[cfg(test)]
mod tests;
