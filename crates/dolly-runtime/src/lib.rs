//! Bounded G1 Runtime transaction engine.
//!
//! The engine is the narrow layer above the accepted WP-004 durable reducer
//! transaction. It validates a frozen Activation Manifest, durably issues one
//! lease, and returns an immutable execution premise. It deliberately stops
//! before dispatch bytes, Extension code, or any external effect.

mod premise;
mod validation;

use dolly_core_reducer::{
    ActivationState, BuildManifestCommand, CoreCommand, EnvironmentInput, IssueLeaseCommand,
    Transition, TransitionOutcome,
};
use dolly_storage::{SqliteCoreStore, StorageError};
use rusqlite::Connection;
use serde_json::{Value, json};
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
