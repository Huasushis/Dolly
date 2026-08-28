//! Bounded G1 Runtime transaction engine.
//!
//! The engine is the narrow layer above the accepted WP-004 durable reducer
//! transaction. It validates a frozen Activation Manifest, durably issues one
//! lease, and exposes the canonical dispatch frame only after its started
//! marker commits. It never invokes Extension code or any external effect.

mod premise;
mod validation;

use dolly_canonical_json::{canonicalize, Sha256Digest};
use dolly_core_domain::{LeaseToken, WorkerEpoch};
use dolly_core_reducer::{
    ActivationState, BuildManifestCommand, CoreCommand, DispatchLeaseCommand, DispatchState,
    EnvironmentInput, IssueLeaseCommand, Transition, TransitionOutcome,
};
use dolly_storage::{SqliteCoreStore, StorageError};
use rusqlite::Connection;
use serde_json::{json, Value};
use thiserror::Error;

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
        command: &IssueLeaseCommand,
        input: &EnvironmentInput,
    ) -> RuntimeResult<ExecutionPremise> {
        validate_lease_request(command)?;
        let snapshot = self.store.snapshot()?;
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
        validate_existing_lease_or_state(&snapshot, command, activation.state)?;

        let transition = self
            .store
            .transact(&CoreCommand::IssueLease(command.clone()), input)?;
        require_committed(&transition)?;
        build_premise(&transition.state, command, validated)
    }

    /// Build the exact canonical `module.activate` frame and durably mark it
    /// `started`. The frame is returned only after the marker commits.
    ///
    /// `premise` must be the result of `prepare_execution`. `worker_epoch` and
    /// `lease_token` are Runtime-owned values; `request_id` is allocated by the
    /// Host sender. This method never writes transport bytes or invokes
    /// Extension code.
    pub fn dispatch_execution(
        &mut self,
        premise: &ExecutionPremise,
        dispatch_command_id: &str,
        worker_epoch: &WorkerEpoch,
        lease_token: &LeaseToken,
        request_id: &str,
        input: &EnvironmentInput,
    ) -> RuntimeResult<DispatchResult> {
        if dispatch_command_id.is_empty() || request_id.is_empty() {
            return Err(RuntimeError::DispatchInvalid {
                detail: "dispatch command_id and request_id are required".into(),
            });
        }

        let snapshot = self.store.snapshot()?;
        let manifest_value = retained_manifest_for_dispatch(&snapshot, premise, lease_token)?;
        let (manifest, _) = validation::validate_manifest_for_replay(&manifest_value)?;
        let frame = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "module.activate",
            "params": {
                "worker_epoch": worker_epoch,
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
                frame_digest: Some(frame_digest.clone()),
            }),
            input,
        )?;
        require_committed(&transition)?;
        let committed_digest = transition
            .state
            .leases
            .get(premise.fence().lease_id())
            .and_then(|lease| lease.get("frame_digest"))
            .and_then(Value::as_str);
        let committed_state = transition
            .state
            .activations
            .get(premise.identity().activation_id())
            .map(|activation| activation.state);
        if committed_state != Some(ActivationState::Dispatched)
            || committed_digest != Some(frame_digest.as_str())
        {
            return Err(RuntimeError::PremiseUnavailable {
                detail: "committed dispatch does not retain the exact frame digest".into(),
            });
        }
        Ok(DispatchResult {
            frame_bytes,
            frame_digest,
            transition,
        })
    }
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
    if activation.state != ActivationState::Leased {
        return Err(RuntimeError::PremiseUnavailable {
            detail: "dispatch Activation is no longer leased".into(),
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
    let token_digest = Sha256Digest::compute(lease_token.expose_bytes()).to_canonical_string();
    if lease.get("activation_id").and_then(Value::as_str)
        != Some(premise.identity().activation_id())
        || lease.get("attempt").and_then(Value::as_i64) != Some(premise.fence().attempt())
        || lease.get("worker_epoch").and_then(Value::as_i64) != Some(premise.fence().worker_epoch())
        || lease.get("extension_generation").and_then(Value::as_i64)
            != Some(premise.fence().extension_generation())
        || lease.get("extension_connection_id").and_then(Value::as_str)
            != Some(premise.fence().extension_connection_id())
        || lease.get("token_digest").and_then(Value::as_str) != Some(token_digest.as_str())
        || lease.get("dispatch_state").and_then(Value::as_str) != Some("prepared")
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
    if command.worker_epoch <= 0 {
        return Err(RuntimeError::GenerationInvalid {
            detail: "worker_epoch must be positive".into(),
        });
    }
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
    if lease.get("activation_id").and_then(Value::as_str) != Some(command.activation_id.as_str())
        || lease.get("dispatch_state").and_then(Value::as_str) != Some("prepared")
        || lease.get("manifest_digest").and_then(Value::as_str) != Some(manifest_digest.as_str())
    {
        return Err(RuntimeError::PremiseUnavailable {
            detail: "committed lease does not bind the retained Manifest and prepared state".into(),
        });
    }
    let worker_epoch = lease
        .get("worker_epoch")
        .and_then(Value::as_i64)
        .ok_or_else(|| RuntimeError::PremiseUnavailable {
            detail: "committed lease has no Worker epoch".into(),
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
        || worker_epoch != command.worker_epoch
        || extension_generation != command.extension_generation.unwrap_or_default()
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
            worker_epoch,
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
