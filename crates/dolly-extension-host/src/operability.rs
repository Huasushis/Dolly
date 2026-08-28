//! G3 operational boundaries built on the accepted G2 invocation.
//!
//! The operational premise has no public constructor; it is produced only by
//! `admit_operational_activation` after G2 has accepted the canonical
//! invocation. External I/O then requires that premise, an exact Host-owned
//! policy, a live generation, and a secret reference that resolves at use.
//! The stop gate is held through the effect callback, so a completed stop
//! cannot race a later effect.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::{Arc, Mutex};

use dolly_canonical_json::{Sha256Digest, canonicalize};
use dolly_core_domain::{ExtensionId, WorkerEpoch};
use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority, SqliteCoreStore};

use crate::config_transaction::{
    ConfigurationError, ConfigurationSnapshot, ConfigurationStore, MAX_CONFIGURATION_REVISION,
};

use dolly_worker::daemon::{DaemonError, DaemonLifecycleToken, InFlightWork};

use crate::FencedInvocationPremise;
use crate::SecretRef;

/// Opaque configuration authority issued only from a live operational premise.
/// It retains the daemon lifecycle token so stop and restart invalidate it.
pub struct ConfigurationTransactionAuthority {
    authority_digest: Sha256Digest,
    authority_jcs: Vec<u8>,
    lifecycle: Option<DaemonLifecycleToken>,
}

impl ConfigurationTransactionAuthority {
    fn from_live(
        extension_id: &str,
        module_id: &str,
        host: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
        base: &ConfigurationSnapshot,
        lifecycle: &DaemonLifecycleToken,
    ) -> Result<Self, ExternalIoError> {
        lifecycle.check().map_err(map_lifecycle_error)?;
        let lifecycle_generation = lifecycle.generation().value();
        let worker_epoch: WorkerEpoch = grant
            .worker_epoch()
            .parse()
            .map_err(|_| ExternalIoError::StaleGeneration)?;
        let graph_revision = u64::try_from(grant.graph_revision())
            .map_err(|_| ExternalIoError::StaleGeneration)?;
        let extension_generation = grant.extension_generation();
        let graph_digest: Sha256Digest = grant
            .graph_digest()
            .parse()
            .map_err(|_| ExternalIoError::StaleGeneration)?;
        if extension_id != grant.extension_id()
            || module_id != grant.module_id()
            || grant.extension_connection_id() != host.extension_connection_id()
            || worker_epoch != *host.worker_epoch()
            || grant.worker_epoch_fence() != host.worker_epoch_fence()
            || grant.incarnation_revision() != host.incarnation_revision()
            || extension_generation <= 0
            || lifecycle_generation != extension_generation as u64
            || base.revision() > MAX_CONFIGURATION_REVISION
            || graph_revision == 0
            || graph_revision > MAX_CONFIGURATION_REVISION
        {
            return Err(ExternalIoError::StaleGeneration);
        }
        let authority_value = serde_json::json!({
            "extension_id": extension_id,
            "module_id": module_id,
            "extension_connection_id": host.extension_connection_id(),
            "host_incarnation_revision": host.incarnation_revision(),
            "worker_epoch": worker_epoch.to_string(),
            "worker_epoch_fence": host.worker_epoch_fence(),
            "daemon_generation": lifecycle_generation,
            "extension_generation": extension_generation,
            "base_config_revision": base.revision(),
            "base_config_digest": base.digest().to_canonical_string(),
            "graph_revision": graph_revision,
            "graph_digest": graph_digest.to_canonical_string(),
            "control_channel_id": host.extension_connection_id(),
        });
        let (authority_bytes, authority_digest) =
            canonicalize(&authority_value).map_err(|_| ExternalIoError::StaleGeneration)?;
        Ok(Self {
            authority_digest,
            authority_jcs: authority_bytes.into_vec(),
            lifecycle: Some(lifecycle.clone()),
        })
    }

    pub fn authority_digest(&self) -> &Sha256Digest {
        &self.authority_digest
    }

    pub(crate) fn authority_jcs(&self) -> &[u8] {
        &self.authority_jcs
    }
    pub(crate) fn check_live(&self) -> Result<(), ConfigurationError> {
        match self.lifecycle.as_ref() {
            Some(lifecycle) => lifecycle
                .check()
                .map_err(|_| ConfigurationError::AuthorityConflict),
            None => {
                #[cfg(test)]
                {
                    Ok(())
                }
                #[cfg(not(test))]
                {
                    Err(ConfigurationError::AuthorityUnavailable)
                }
            }
        }
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_test_parts(
        extension_id: impl Into<String>,
        module_id: impl Into<String>,
        extension_connection_id: impl Into<String>,
        host_incarnation_revision: i64,
        worker_epoch: WorkerEpoch,
        worker_epoch_fence: i64,
        daemon_generation: u64,
        extension_generation: i64,
        base_config_revision: u64,
        base_config_digest: Sha256Digest,
        graph_revision: u64,
        graph_digest: Sha256Digest,
        control_channel_id: impl Into<String>,
    ) -> Result<Self, ExternalIoError> {
        let authority_value = serde_json::json!({
            "extension_id": extension_id.into(),
            "module_id": module_id.into(),
            "extension_connection_id": extension_connection_id.into(),
            "host_incarnation_revision": host_incarnation_revision,
            "worker_epoch": worker_epoch.to_string(),
            "worker_epoch_fence": worker_epoch_fence,
            "daemon_generation": daemon_generation,
            "extension_generation": extension_generation,
            "base_config_revision": base_config_revision,
            "base_config_digest": base_config_digest.to_canonical_string(),
            "graph_revision": graph_revision,
            "graph_digest": graph_digest.to_canonical_string(),
            "control_channel_id": control_channel_id.into(),
        });
        let (authority_bytes, authority_digest) =
            canonicalize(&authority_value).map_err(|_| ExternalIoError::StaleGeneration)?;
        Ok(Self {
            authority_digest,
            authority_jcs: authority_bytes.into_vec(),
            lifecycle: None,
        })
    }
}

impl fmt::Debug for ConfigurationTransactionAuthority {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConfigurationTransactionAuthority")
            .field("authority_digest", &self.authority_digest)
            .finish()
    }
}

impl PartialEq for ConfigurationTransactionAuthority {
    fn eq(&self, other: &Self) -> bool {
        self.authority_digest == other.authority_digest && self.authority_jcs == other.authority_jcs
    }
}

impl Eq for ConfigurationTransactionAuthority {}

/// The explicit operational premise produced from one accepted G2 invocation.
///
/// Its private field preserves the G2 fence and prevents callers from
/// fabricating the identity, configuration revision, or Extension generation
/// used by the external-I/O boundary.
#[derive(Clone, Debug)]
pub struct OperationalPremise {
    invocation: FencedInvocationPremise,
    lifecycle: Option<DaemonLifecycleToken>,
}

impl OperationalPremise {
    pub(crate) fn from_admitted(invocation: FencedInvocationPremise) -> Self {
        Self {
            invocation,
            lifecycle: None,
        }
    }
    pub(crate) fn bind_lifecycle(
        mut self,
        lifecycle: DaemonLifecycleToken,
    ) -> Result<Self, ExternalIoError> {
        let extension_id = self.extension_id().ok_or(ExternalIoError::Unauthorized)?;
        if !lifecycle.matches_owner(
            extension_id,
            self.module_id(),
            self.invocation.extension_connection_id(),
            self.invocation.incarnation_revision(),
            self.invocation.worker_epoch(),
            self.invocation.worker_epoch_fence(),
            self.extension_generation(),
        ) {
            return Err(ExternalIoError::StaleGeneration);
        }
        lifecycle.check().map_err(map_lifecycle_error)?;
        self.lifecycle = Some(lifecycle);
        Ok(self)
    }

    pub fn invocation(&self) -> &FencedInvocationPremise {
        &self.invocation
    }

    pub fn activation_id(&self) -> &str {
        self.invocation.activation_id()
    }

    pub fn module_id(&self) -> &str {
        self.invocation.module_id()
    }

    pub fn extension_id(&self) -> Option<&str> {
        self.invocation.extension_id()
    }

    pub fn config_revision(&self) -> u64 {
        self.invocation.manifest().config_revision.value()
    }

    pub fn extension_generation(&self) -> i64 {
        self.invocation.extension_generation()
    }

    /// Create the immutable configuration authority for this live invocation.
    ///
    /// The authority is available only after the exact daemon lifecycle has
    /// been bound to this admitted premise. The supplied snapshot is the
    /// canonical configuration base used by the transaction request.
    pub fn configuration_transaction_authority(
        &self,
        base: &ConfigurationSnapshot,
        store: &SqliteCoreStore<'_>,
    ) -> Result<ConfigurationTransactionAuthority, ExternalIoError> {
        let lifecycle = self
            .lifecycle
            .as_ref()
            .ok_or(ExternalIoError::StaleGeneration)?;
        lifecycle.check().map_err(map_lifecycle_error)?;
        let extension_id = self.extension_id().ok_or(ExternalIoError::Unauthorized)?;
        let policy = self
            .invocation
            .capability_policy
            .as_ref()
            .ok_or(ExternalIoError::Unauthorized)?;
        let host = store
            .authenticated_host_connection()
            .map_err(|_| ExternalIoError::Unauthorized)?;
        let grant = store
            .verify_host_capability_grant(
                &host,
                extension_id,
                self.module_id(),
                policy.grant_revision,
                &policy.grant_digest,
            )
            .map_err(|_| ExternalIoError::Unauthorized)?
            .ok_or(ExternalIoError::Unauthorized)?;
        ConfigurationTransactionAuthority::from_live(
            extension_id,
            self.module_id(),
            &host,
            &grant,
            base,
            lifecycle,
        )
    }

    /// Bind the authority to the configuration ledger after rechecking the
    /// live lifecycle and durable Host state.
    pub fn bind_configuration_authority(
        &self,
        store: &mut ConfigurationStore<'_>,
        authority: &ConfigurationTransactionAuthority,
    ) -> Result<(), ConfigurationError> {
        let lifecycle = self
            .lifecycle
            .as_ref()
            .ok_or(ConfigurationError::AuthorityUnavailable)?;
        lifecycle
            .check()
            .map_err(|_| ConfigurationError::AuthorityConflict)?;
        store.bind_authority(authority)
    }

    /// Rotate the authority after checking the live lifecycle and durable Host
    /// state.
    pub fn rotate_configuration_authority(
        &self,
        store: &mut ConfigurationStore<'_>,
        previous: &ConfigurationTransactionAuthority,
        next: &ConfigurationTransactionAuthority,
    ) -> Result<(), ConfigurationError> {
        let lifecycle = self
            .lifecycle
            .as_ref()
            .ok_or(ConfigurationError::AuthorityUnavailable)?;
        lifecycle
            .check()
            .map_err(|_| ConfigurationError::AuthorityConflict)?;
        store.rotate_authority(previous, next)
    }
}

/// Exact network destination identity. Wildcards, user-info, and path
/// traversal are rejected; policy matching compares the complete value.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ExternalTarget {
    scheme: String,
    host: String,
    port: u16,
    path: String,
}

impl ExternalTarget {
    pub fn new(
        scheme: impl Into<String>,
        host: impl Into<String>,
        port: u16,
        path: impl Into<String>,
    ) -> Result<Self, IoPolicyError> {
        let scheme = scheme.into().to_ascii_lowercase();
        let host = host.into().to_ascii_lowercase();
        let path = path.into();
        if !valid_scheme(&scheme)
            || !valid_host(&host)
            || port == 0
            || path.is_empty()
            || path.len() > 2048
            || !path.starts_with('/')
            || path.contains("..")
            || path.bytes().any(|byte| byte.is_ascii_control())
        {
            return Err(IoPolicyError::InvalidTarget);
        }
        Ok(Self {
            scheme,
            host,
            port,
            path,
        })
    }

    pub fn scheme(&self) -> &str {
        &self.scheme
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn path(&self) -> &str {
        &self.path
    }
}

impl fmt::Debug for ExternalTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExternalTarget")
            .field("scheme", &self.scheme)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("path", &self.path)
            .finish()
    }
}

/// Host-owned exact external-I/O allowlist bound to one config and Extension
/// generation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalIoPolicy {
    extension_id: String,
    config_revision: u64,
    extension_generation: i64,
    operations: BTreeSet<String>,
    targets: BTreeSet<ExternalTarget>,
}

impl ExternalIoPolicy {
    pub fn new(
        extension_id: impl Into<String>,
        config_revision: u64,
        extension_generation: i64,
    ) -> Result<Self, IoPolicyError> {
        let extension_id = extension_id.into();
        validate_extension_id(&extension_id)?;
        if config_revision == 0 || extension_generation <= 0 {
            return Err(IoPolicyError::InvalidBinding);
        }
        Ok(Self {
            extension_id,
            config_revision,
            extension_generation,
            operations: BTreeSet::new(),
            targets: BTreeSet::new(),
        })
    }

    pub fn allow_operation(&mut self, operation: impl Into<String>) -> Result<(), IoPolicyError> {
        let operation = operation.into();
        if !valid_operation(&operation) {
            return Err(IoPolicyError::InvalidOperation);
        }
        self.operations.insert(operation);
        Ok(())
    }

    pub fn allow_target(&mut self, target: ExternalTarget) {
        self.targets.insert(target);
    }

    pub fn extension_id(&self) -> &str {
        &self.extension_id
    }

    pub fn config_revision(&self) -> u64 {
        self.config_revision
    }

    pub fn extension_generation(&self) -> i64 {
        self.extension_generation
    }

    pub fn allows_operation(&self, operation: &str) -> bool {
        self.operations.contains(operation)
    }

    pub fn allows_target(&self, target: &ExternalTarget) -> bool {
        self.targets.contains(target)
    }
}

/// One requested external effect. Identity comes from the operational
/// premise; the request can supply only its Extension claim, operation,
/// target, and optional opaque secret reference.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalIoRequest {
    extension_id: String,
    operation: String,
    target: ExternalTarget,
    secret_ref: Option<SecretRef>,
}

impl ExternalIoRequest {
    pub fn new(
        extension_id: impl Into<String>,
        operation: impl Into<String>,
        target: ExternalTarget,
        secret_ref: Option<SecretRef>,
    ) -> Result<Self, IoPolicyError> {
        let extension_id = extension_id.into();
        let operation = operation.into();
        validate_extension_id(&extension_id)?;
        if !valid_operation(&operation) {
            return Err(IoPolicyError::InvalidOperation);
        }
        Ok(Self {
            extension_id,
            operation,
            target,
            secret_ref,
        })
    }

    pub fn extension_id(&self) -> &str {
        &self.extension_id
    }

    pub fn operation(&self) -> &str {
        &self.operation
    }

    pub fn target(&self) -> &ExternalTarget {
        &self.target
    }

    pub fn secret_ref(&self) -> Option<&SecretRef> {
        self.secret_ref.as_ref()
    }
}

/// Construction-time policy errors. No secret material is carried.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum IoPolicyError {
    #[error("external I/O binding is invalid")]
    InvalidBinding,
    #[error("external I/O target is invalid")]
    InvalidTarget,
    #[error("external I/O operation is invalid")]
    InvalidOperation,
    #[error("Extension identity is invalid")]
    InvalidExtension,
}

/// Reasons an external effect is denied before its callback can run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ExternalIoError {
    #[error("external I/O authority is unavailable")]
    AuthorityUnavailable,
    #[error("external I/O is stopped")]
    Stopped,
    #[error("external I/O generation is stale")]
    StaleGeneration,
    #[error("external I/O invocation is unauthorized")]
    Unauthorized,
    #[error("external I/O invocation crosses Extension ownership")]
    CrossExtension,
    #[error("external I/O operation is not allowed")]
    OperationNotAllowed,
    #[error("external I/O target is not allowed")]
    TargetNotAllowed,
}

fn map_lifecycle_error(error: DaemonError) -> ExternalIoError {
    match error {
        DaemonError::WorkCancelled => ExternalIoError::Stopped,
        DaemonError::StaleWorkGuard => ExternalIoError::StaleGeneration,
        _ => ExternalIoError::AuthorityUnavailable,
    }
}

/// An execution error that distinguishes denial, unresolved secrets, and the
/// caller's effect error. The effect is called only after all checks pass.
#[derive(Debug)]
pub enum ExternalIoExecutionError<E> {
    Denied(ExternalIoError),
    SecretUnavailable,
    Effect(E),
}

/// Secret bytes exist only inside a Host callback and are wiped on drop.
/// There is no `Debug`, `Serialize`, or raw-byte accessor.
pub struct SecretMaterial(Vec<u8>);

impl SecretMaterial {
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self(bytes.to_vec())
    }

    pub fn with_bytes<T>(&self, callback: impl FnOnce(&[u8]) -> T) -> T {
        callback(&self.0)
    }
}

impl fmt::Debug for SecretMaterial {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretMaterial(<redacted>)")
    }
}

impl Drop for SecretMaterial {
    fn drop(&mut self) {
        for byte in &mut self.0 {
            // Volatile writes prevent the compiler from removing the wipe.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
    }
}

/// Host-owned provider interface. Implementations return material only to the
/// sealed Host authority; callers receive it through a use callback.
pub trait SecretProvider: Send + Sync {
    fn resolve(&self, reference: &SecretRef) -> Result<SecretMaterial, SecretError>;
}

/// Fail-closed secret provider errors; references and material are omitted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SecretError {
    #[error("secret is unavailable")]
    Unavailable,
}

/// Sealed Host authority for resolving a `SecretRef` at use time.
#[derive(Clone)]
pub struct HostSecretAuthority {
    provider: Arc<dyn SecretProvider>,
}

impl HostSecretAuthority {
    pub fn new(provider: Arc<dyn SecretProvider>) -> Self {
        Self { provider }
    }

    fn with_secret<T>(
        &self,
        reference: &SecretRef,
        callback: impl FnOnce(&[u8]) -> T,
    ) -> Result<T, SecretError> {
        let material = self.provider.resolve(reference)?;
        Ok(material.with_bytes(callback))
    }
}

impl fmt::Debug for HostSecretAuthority {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HostSecretAuthority(<sealed>)")
    }
}

/// In-memory Host provider for local process tests. Production providers can
/// implement `SecretProvider` without exposing durable plaintext.
#[derive(Default)]
pub struct InMemorySecretProvider {
    values: Mutex<BTreeMap<SecretRef, Vec<u8>>>,
}

impl InMemorySecretProvider {
    pub fn insert(&self, reference: SecretRef, bytes: &[u8]) {
        if let Ok(mut values) = self.values.lock() {
            values.insert(reference, bytes.to_vec());
        }
    }
}

impl fmt::Debug for InMemorySecretProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("InMemorySecretProvider(<sealed>)")
    }
}

impl SecretProvider for InMemorySecretProvider {
    fn resolve(&self, reference: &SecretRef) -> Result<SecretMaterial, SecretError> {
        let values = self.values.lock().map_err(|_| SecretError::Unavailable)?;
        values
            .get(reference)
            .map(|bytes| SecretMaterial::from_bytes(bytes))
            .ok_or(SecretError::Unavailable)
    }
}

#[derive(Debug)]
struct GateState {
    active_generation: i64,
    stopped: bool,
}

/// Host authority that combines exact policy, sealed secret use, and a stop
/// gate held across the actual effect callback.
#[derive(Clone)]
pub struct HostExternalIoAuthority {
    policy: Arc<ExternalIoPolicy>,
    secrets: HostSecretAuthority,
    gate: Arc<Mutex<GateState>>,
}

impl HostExternalIoAuthority {
    pub fn new(policy: ExternalIoPolicy, secrets: HostSecretAuthority) -> Self {
        let generation = policy.extension_generation();
        Self {
            policy: Arc::new(policy),
            secrets,
            gate: Arc::new(Mutex::new(GateState {
                active_generation: generation,
                stopped: false,
            })),
        }
    }

    pub fn policy(&self) -> &ExternalIoPolicy {
        &self.policy
    }

    /// Mark the authority stopped before any later effect may enter.
    pub fn stop(&self) {
        if let Ok(mut gate) = self.gate.lock() {
            gate.stopped = true;
        }
    }

    /// Start a new live generation after a supervised daemon restart.
    pub fn start_generation(&self, generation: i64) -> Result<(), ExternalIoError> {
        if generation <= 0 {
            return Err(ExternalIoError::StaleGeneration);
        }
        let mut gate = self
            .gate
            .lock()
            .map_err(|_| ExternalIoError::AuthorityUnavailable)?;
        gate.active_generation = generation;
        gate.stopped = false;
        Ok(())
    }

    pub fn authorize(
        &self,
        premise: &OperationalPremise,
        request: ExternalIoRequest,
    ) -> Result<ExternalIoPermit, ExternalIoError> {
        let lifecycle = premise
            .lifecycle
            .as_ref()
            .ok_or(ExternalIoError::StaleGeneration)?;
        lifecycle.check().map_err(map_lifecycle_error)?;
        self.authorize_claims_with_lifecycle(
            premise.extension_id(),
            premise.config_revision(),
            premise.extension_generation(),
            request,
            Some(lifecycle.clone()),
        )
    }

    #[cfg(test)]
    fn authorize_claims(
        &self,
        premise_extension: Option<&str>,
        config_revision: u64,
        generation: i64,
        request: ExternalIoRequest,
    ) -> Result<ExternalIoPermit, ExternalIoError> {
        self.authorize_claims_with_lifecycle(
            premise_extension,
            config_revision,
            generation,
            request,
            None,
        )
    }

    fn authorize_claims_with_lifecycle(
        &self,
        premise_extension: Option<&str>,
        config_revision: u64,
        generation: i64,
        request: ExternalIoRequest,
        lifecycle: Option<DaemonLifecycleToken>,
    ) -> Result<ExternalIoPermit, ExternalIoError> {
        if let Some(lifecycle) = &lifecycle {
            lifecycle.check().map_err(map_lifecycle_error)?;
            if u64::try_from(generation).ok() != Some(lifecycle.generation().value()) {
                return Err(ExternalIoError::StaleGeneration);
            }
        }
        let gate = self
            .gate
            .lock()
            .map_err(|_| ExternalIoError::AuthorityUnavailable)?;
        if gate.stopped {
            return Err(ExternalIoError::Stopped);
        }
        if gate.active_generation != generation
            || self.policy.extension_generation() != generation
            || self.policy.config_revision() != config_revision
        {
            return Err(ExternalIoError::StaleGeneration);
        }
        drop(gate);

        let premise_extension = premise_extension.ok_or(ExternalIoError::Unauthorized)?;
        if request.extension_id() != premise_extension {
            return Err(ExternalIoError::CrossExtension);
        }
        if self.policy.extension_id() != premise_extension {
            return Err(ExternalIoError::Unauthorized);
        }
        if !self.policy.allows_operation(request.operation()) {
            return Err(ExternalIoError::OperationNotAllowed);
        }
        if !self.policy.allows_target(request.target()) {
            return Err(ExternalIoError::TargetNotAllowed);
        }
        if let Some(lifecycle) = &lifecycle {
            lifecycle.check().map_err(map_lifecycle_error)?;
        }
        Ok(ExternalIoPermit {
            authority: self.clone(),
            request,
            generation,
            lifecycle,
        })
    }
}
/// A one-shot permit returned only after policy, premise, and lifecycle checks.
pub struct ExternalIoPermit {
    authority: HostExternalIoAuthority,
    request: ExternalIoRequest,
    generation: i64,
    lifecycle: Option<DaemonLifecycleToken>,
}

impl fmt::Debug for HostExternalIoAuthority {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HostExternalIoAuthority")
            .field("policy", &self.policy)
            .field("secrets", &self.secrets)
            .finish()
    }
}

impl fmt::Debug for ExternalIoPermit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExternalIoPermit")
            .field("operation", &self.request.operation)
            .field("target", &self.request.target)
            .field("generation", &self.generation)
            .finish()
    }
}

/// Safe request metadata and an optional borrowed secret available only while
/// the one-shot external effect runs.
pub struct ExternalIoContext<'a> {
    request: &'a ExternalIoRequest,
    secret: Option<&'a [u8]>,
    cancellation: Option<&'a InFlightWork>,
}

impl<'a> ExternalIoContext<'a> {
    pub fn operation(&self) -> &str {
        self.request.operation()
    }

    pub fn target(&self) -> &ExternalTarget {
        self.request.target()
    }

    pub fn secret_bytes(&self) -> Option<&[u8]> {
        self.secret
    }

    /// Observe cancellation requested by the supervising daemon lifecycle.
    pub fn is_cancelled(&self) -> bool {
        self.cancellation
            .map(InFlightWork::is_cancelled)
            .unwrap_or(false)
    }
}

impl fmt::Debug for ExternalIoContext<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExternalIoContext")
            .field("operation", &self.request.operation)
            .field("target", &self.request.target)
            .field("has_secret", &self.secret.is_some())
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl ExternalIoPermit {
    /// Resolve the `SecretRef`, re-check stop/generation and cancellation, and
    /// only then invoke the external/business effect. The stop lifecycle
    /// remains tracked until the callback returns.
    pub fn execute<T, E>(
        self,
        effect: impl FnOnce(ExternalIoContext<'_>) -> Result<T, E>,
    ) -> Result<T, ExternalIoExecutionError<E>> {
        let in_flight = self
            .lifecycle
            .as_ref()
            .map(DaemonLifecycleToken::begin_in_flight)
            .transpose()
            .map_err(|error| ExternalIoExecutionError::Denied(map_lifecycle_error(error)))?;
        if let Some(scope) = &in_flight {
            scope
                .check()
                .map_err(|error| ExternalIoExecutionError::Denied(map_lifecycle_error(error)))?;
        }
        let gate =
            self.authority.gate.lock().map_err(|_| {
                ExternalIoExecutionError::Denied(ExternalIoError::AuthorityUnavailable)
            })?;
        if gate.stopped {
            return Err(ExternalIoExecutionError::Denied(ExternalIoError::Stopped));
        }
        if gate.active_generation != self.generation
            || self.authority.policy.extension_generation() != self.generation
        {
            return Err(ExternalIoExecutionError::Denied(
                ExternalIoError::StaleGeneration,
            ));
        }
        if let Some(scope) = &in_flight {
            scope
                .check()
                .map_err(|error| ExternalIoExecutionError::Denied(map_lifecycle_error(error)))?;
        }

        let result = match self.request.secret_ref() {
            Some(reference) => {
                let resolved = self.authority.secrets.with_secret(reference, |secret| {
                    if let Some(scope) = &in_flight {
                        scope.check().map_err(|error| {
                            ExternalIoExecutionError::Denied(map_lifecycle_error(error))
                        })?;
                    }
                    effect(ExternalIoContext {
                        request: &self.request,
                        secret: Some(secret),
                        cancellation: in_flight.as_ref(),
                    })
                    .map_err(ExternalIoExecutionError::Effect)
                });
                match resolved {
                    Ok(result) => result,
                    Err(_) => return Err(ExternalIoExecutionError::SecretUnavailable),
                }
            }
            None => {
                if let Some(scope) = &in_flight {
                    scope.check().map_err(|error| {
                        ExternalIoExecutionError::Denied(map_lifecycle_error(error))
                    })?;
                }
                effect(ExternalIoContext {
                    request: &self.request,
                    secret: None,
                    cancellation: in_flight.as_ref(),
                })
                .map_err(ExternalIoExecutionError::Effect)
            }
        };
        result
    }
}

fn validate_extension_id(value: &str) -> Result<(), IoPolicyError> {
    value
        .parse::<ExtensionId>()
        .map(|_| ())
        .map_err(|_| IoPolicyError::InvalidExtension)
}

fn valid_scheme(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.bytes().enumerate().all(|(index, byte)| {
            (index == 0 && byte.is_ascii_lowercase())
                || (index > 0
                    && (byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'+' | b'-' | b'.')))
        })
}

fn valid_host(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value.contains(['/', '?', '#', '@', '*'])
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b':' | b'-' | b'_' | b'[' | b']')
        })
}

fn valid_operation(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            (index == 0 && byte.is_ascii_lowercase())
                || (index > 0
                    && (byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'.' | b'_' | b'-')))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_material_is_not_debuggable_and_resolves_only_in_a_callback() {
        let reference: SecretRef = "secret://vault/api".parse().expect("reference");
        let provider = Arc::new(InMemorySecretProvider::default());
        provider.insert(reference.clone(), b"plain-secret");
        let authority = HostSecretAuthority::new(provider);
        let debug = format!("{authority:?}");
        assert!(!debug.contains("plain-secret"));
        let used = authority
            .with_secret(&reference, |secret| secret == b"plain-secret")
            .expect("resolved");
        assert!(used);
        assert!(matches!(
            authority.with_secret(&"secret://vault/missing".parse().unwrap(), |_| ()),
            Err(SecretError::Unavailable)
        ));
    }

    #[test]
    fn exact_target_matching_rejects_unlisted_egress() {
        let target =
            ExternalTarget::new("https", "api.example.test", 443, "/v1/data").expect("target");
        let mut policy = ExternalIoPolicy::new("org.example.extension", 1, 4).unwrap();
        policy.allow_operation("read").unwrap();
        policy.allow_target(target.clone());
        assert!(policy.allows_target(&target));
        assert!(!policy.allows_target(
            &ExternalTarget::new("https", "api.example.test", 443, "/v1/other").unwrap()
        ));
    }

    #[test]
    fn stop_is_checked_before_secret_resolution_and_effect() {
        let reference: SecretRef = "secret://vault/api".parse().unwrap();
        let provider = Arc::new(InMemorySecretProvider::default());
        provider.insert(reference.clone(), b"plain-secret");
        let target = ExternalTarget::new("https", "api.example.test", 443, "/v1/data").unwrap();
        let mut policy = ExternalIoPolicy::new("org.example.extension", 1, 4).unwrap();
        policy.allow_operation("read").unwrap();
        policy.allow_target(target.clone());
        let authority = HostExternalIoAuthority::new(policy, HostSecretAuthority::new(provider));
        let request =
            ExternalIoRequest::new("org.example.extension", "read", target, Some(reference))
                .unwrap();
        let permit = authority
            .authorize_claims(Some("org.example.extension"), 1, 4, request)
            .unwrap();
        authority.stop();
        let effects = std::cell::Cell::new(0);
        let result = permit.execute(|_| {
            effects.set(effects.get() + 1);
            Ok::<_, ()>(())
        });
        assert!(matches!(
            result,
            Err(ExternalIoExecutionError::Denied(ExternalIoError::Stopped))
        ));
        assert_eq!(effects.get(), 0);
    }

    #[test]
    fn cross_extension_and_unresolved_secret_are_denied_without_effect() {
        let target = ExternalTarget::new("https", "api.example.test", 443, "/v1/data").unwrap();
        let mut policy = ExternalIoPolicy::new("org.example.extension", 1, 4).unwrap();
        policy.allow_operation("read").unwrap();
        policy.allow_target(target.clone());
        let authority = HostExternalIoAuthority::new(
            policy,
            HostSecretAuthority::new(Arc::new(InMemorySecretProvider::default())),
        );
        let cross =
            ExternalIoRequest::new("org.other.extension", "read", target.clone(), None).unwrap();
        assert!(matches!(
            authority.authorize_claims(Some("org.example.extension"), 1, 4, cross),
            Err(ExternalIoError::CrossExtension)
        ));
        let missing: SecretRef = "secret://vault/missing".parse().unwrap();
        let request =
            ExternalIoRequest::new("org.example.extension", "read", target, Some(missing)).unwrap();
        let permit = authority
            .authorize_claims(Some("org.example.extension"), 1, 4, request)
            .unwrap();
        let effects = std::cell::Cell::new(0);
        let result = permit.execute(|_| {
            effects.set(effects.get() + 1);
            Ok::<_, ()>(())
        });
        assert!(matches!(
            result,
            Err(ExternalIoExecutionError::SecretUnavailable)
        ));
        assert_eq!(effects.get(), 0);
    }

    #[test]
    fn stale_generation_is_denied() {
        let target = ExternalTarget::new("https", "api.example.test", 443, "/v1/data").unwrap();
        let mut policy = ExternalIoPolicy::new("org.example.extension", 1, 4).unwrap();
        policy.allow_operation("read").unwrap();
        policy.allow_target(target.clone());
        let authority = HostExternalIoAuthority::new(
            policy,
            HostSecretAuthority::new(Arc::new(InMemorySecretProvider::default())),
        );
        let request =
            ExternalIoRequest::new("org.example.extension", "read", target, None).unwrap();
        assert!(matches!(
            authority.authorize_claims(Some("org.example.extension"), 1, 3, request),
            Err(ExternalIoError::StaleGeneration)
        ));
    }
}
