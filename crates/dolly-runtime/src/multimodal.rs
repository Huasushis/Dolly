//! Runtime-owned WP-013B multimodal adapters — the single Runtime
//! implementation of the accepted `dolly-channel` sealed Asset seams.
//!
//! Outbound: [`ChannelAssetSeam`] implements `dolly_channel::AssetPreparation`.
//! For every committed `AssetPremise` it acquires the module's Asset
//! capability and a finite short lease from the accepted `AssetService`,
//! runs `AssetService::prepare_media` under the exact committed AssetId and
//! lease, and converts the returned `PreparedMedia` field-for-field into the
//! closed Channel `AssetPayload` (whose durable slice is the `AssetLeaseProof`).
//! No raw store, path, or caller metadata is substituted; the Asset service
//! re-proves availability, ownership, domain, generation, digest, media
//! type, and geometry at preparation time.
//!
//! Inbound: [`ChannelAttachmentImport`] implements
//! `dolly_channel::InboundAssetImport`. It imports one authenticated provider
//! attachment through the Asset façade under the Channel owner/domain/module
//! with an account-scoped deterministic import key, and answers name-based
//! status. `Absent` is reported only when the Asset authority has no durable
//! import record/effect for exactly that key.
//!
//! Every authority question the adapter cannot answer — no bound Asset
//! store/capability, an unavailable/foreign/stale asset, a missing, revoked,
//! or expired lease, a capability from another Host lifecycle, an unsafe or
//! over-bound provider payload — fails closed with the Channel asset code
//! (`CHANNEL_ASSET_IMPORT_FAILED`) and zero transport/durable effect. The
//! default (unbound) construction is the fail-closed text/attachment path a
//! route without a bound Asset store must take; the bound construction is
//! the single production registration per store/account/config lifecycle.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dolly_asset::config::ResolvedAssetConfig;
use dolly_asset::prepare::{MediaPrepareRequest, PreparedMedia};
use dolly_asset::record::{ImportRequest, MediaKind, Source, StatusResult};
use dolly_asset::service::AssetService;
use dolly_channel::asset::{
    AssetId as ChannelAssetId, AssetPayload, AssetPremise, AssetPreparation,
    AssetRef as ChannelAssetRef, ContentHash as ChannelContentHash, MediaKind as ChannelMediaKind,
    MediaType as ChannelMediaType,
};
use dolly_channel::attachment::{
    AttachmentImportRequest, AttachmentImportStatus, AvailableAttachment, InboundAssetImport,
};
use dolly_channel::error::{ChannelError, ChannelOutcome, codes};
use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority};

use crate::host_routes::HostRouteError;

/// The bounded authenticated provider attachment reader the Runtime owns.
/// It reads the exact immutable bytes for one authenticated provider key
/// within a caller-supplied byte bound — never a raw path, ambient network,
/// or caller authority claim. Acceptance injects a deterministic fake;
/// production binds the transport's own provider fetch here.
pub trait ProviderAttachmentReader: Send {
    /// Read the exact bytes for `provider_key`, refusing when the provider
    /// cannot authenticate the key, the bytes are unavailable, or the payload
    /// exceeds `max_bytes`. Errors are closed and must not expose a path,
    /// capability, account, or network detail.
    fn read(&mut self, provider_key: &str, max_bytes: u64) -> Result<Vec<u8>, String>;
}

// ---------------------------------------------------------------------------
// One registered Asset route per store/account/config identity.
// ---------------------------------------------------------------------------

/// The sealed identity a registered Asset route belongs to. Both Channel
/// directions for one extension/module/account/config lifecycle resolve to
/// this key and therefore to one Asset owner thread.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct AssetRouteKey {
    extension_connection_id: String,
    worker_epoch: String,
    extension_id: String,
    module_id: String,
    config_revision: i64,
    principal_account: String,
}

/// Canonical configuration identity for one route owner: RFC 8785 JSON
/// Canonicalization Scheme (JCS) bytes plus the repository SHA-256 digest over
/// the typed revision and the complete serialized `ResolvedAssetConfig`.
/// Nesting the config value means every current and future serialized field is
/// covered without maintaining a second manual field list.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AssetRouteConfigIdentity {
    canonical_jcs: dolly_canonical_json::CanonicalBytes,
    digest: dolly_canonical_json::Sha256Digest,
}

#[derive(serde::Serialize)]
struct AssetRouteConfigIdentityInput<'config> {
    config_revision: i64,
    resolved_asset_config: &'config ResolvedAssetConfig,
}

/// A resolved configuration paired with the one canonical identity computed
/// from that exact value. The owner thread consumes `resolved`; registration
/// and every later route open compare `identity`.
#[derive(Clone)]
struct BoundAssetConfig {
    resolved: ResolvedAssetConfig,
    identity: AssetRouteConfigIdentity,
}

/// The complete recorded identity of one registration. The stable key finds
/// the registration; generation, root, and full resolved configuration must
/// also match.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AssetRouteFacts {
    key: AssetRouteKey,
    instance_id: String,
    extension_generation: i64,
    root_key: String,
    config_identity: AssetRouteConfigIdentity,
}

/// The registration lifecycle. `Closing` rejects every new handle and
/// operation. `Stopping` means the bounded shutdown command has been or is
/// being delivered. `Closed` is reached only after the owner thread joined.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssetOwnerState {
    Starting,
    Active,
    Closing,
    Stopping,
    Closed,
}

struct AssetRouteLifecycle {
    state: AssetOwnerState,
    live_handles: usize,
}

/// Only the data required for one lease plus authoritative media preparation
/// crosses into the owner thread. No service, store, path, capability, or
/// caller-provided closure is part of the request interface.
struct LeaseAndPrepareRequest {
    asset_id: dolly_asset::identity::AssetId,
    expected_media_kind: MediaKind,
    claimed_media_type: dolly_asset::identity::MediaType,
}

#[derive(Debug)]
struct AssetOwnerFailure {
    code: String,
}

enum AssetOwnerRequest {
    LeaseAndPrepare {
        request: LeaseAndPrepareRequest,
        reply: SyncSender<Result<PreparedMedia, AssetOwnerFailure>>,
    },
    Import {
        request: ImportRequest,
        reply: SyncSender<Result<StatusResult, AssetOwnerFailure>>,
    },
    Status {
        import_id: String,
        reply: SyncSender<Result<StatusResult, AssetOwnerFailure>>,
    },
    Shutdown,
}

#[derive(Debug)]
enum AssetOwnerCallError {
    Closed,
    QueueTimeout,
    ReplyTimeout,
    Disconnected,
    Asset(AssetOwnerFailure),
}

impl AssetOwnerCallError {
    fn code(&self) -> &str {
        match self {
            Self::Closed => "ASSET_OWNER_CLOSED",
            Self::QueueTimeout => "ASSET_OWNER_QUEUE_TIMEOUT",
            Self::ReplyTimeout => "ASSET_OWNER_REPLY_TIMEOUT",
            Self::Disconnected => "ASSET_OWNER_DISCONNECTED",
            Self::Asset(failure) => &failure.code,
        }
    }
}

/// Fixed process bounds for the identity-scoped owner. Every caller occupies
/// at most one of eight queue slots, waits at most 250 ms for admission and
/// 30 seconds for an operation reply, and shutdown has one 30-second bound.
const ASSET_OWNER_QUEUE_CAPACITY: usize = 8;
const ASSET_OWNER_ENQUEUE_TIMEOUT: Duration = Duration::from_millis(250);
const ASSET_OWNER_REPLY_TIMEOUT: Duration = Duration::from_secs(30);
const ASSET_OWNER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(30);
const ASSET_OWNER_POLL_INTERVAL: Duration = Duration::from_millis(1);

static LIVE_ASSET_OWNER_THREADS: AtomicUsize = AtomicUsize::new(0);

#[derive(Default)]
struct AssetOwnerMetrics {
    queued_requests: AtomicUsize,
    active_operations: AtomicUsize,
    maximum_active_operations: AtomicUsize,
    thread_live: AtomicBool,
}

struct AssetOwnerThread {
    sender: SyncSender<AssetOwnerRequest>,
    completion: parking_lot::Mutex<Receiver<()>>,
    join: parking_lot::Mutex<Option<JoinHandle<()>>>,
    shutdown_sent: AtomicBool,
    metrics: Arc<AssetOwnerMetrics>,
    config_digest: dolly_canonical_json::Sha256Digest,
}

impl AssetOwnerThread {
    fn spawn(
        config: BoundAssetConfig,
        facts: &AssetRouteFacts,
    ) -> Result<(Self, Receiver<Result<(), AssetOwnerFailure>>), HostRouteError> {
        if config.identity != facts.config_identity {
            return Err(HostRouteError::CapabilityDenied {
                detail:
                    "Asset owner configuration does not match the registered canonical identity"
                        .into(),
            });
        }
        let config_digest = config.identity.digest.clone();
        let resolved_config = config.resolved;
        let (sender, requests) = mpsc::sync_channel(ASSET_OWNER_QUEUE_CAPACITY);
        let (initialization, initialized) = mpsc::sync_channel(1);
        let (completed, completion) = mpsc::sync_channel(1);
        let metrics = Arc::new(AssetOwnerMetrics::default());
        let owner_metrics = Arc::clone(&metrics);
        let domain = facts.key.extension_connection_id.clone();
        let instance = facts.instance_id.clone();
        let module = facts.key.module_id.clone();
        let join = std::thread::Builder::new()
            .name("dolly-asset-owner".to_string())
            .spawn(move || {
                LIVE_ASSET_OWNER_THREADS.fetch_add(1, Ordering::SeqCst);
                owner_metrics.thread_live.store(true, Ordering::SeqCst);
                let mut service = match AssetService::open(resolved_config) {
                    Ok(service) => service,
                    Err(error) => {
                        let _ = initialization.send(Err(AssetOwnerFailure {
                            code: error.to_envelope().code,
                        }));
                        owner_metrics.thread_live.store(false, Ordering::SeqCst);
                        LIVE_ASSET_OWNER_THREADS.fetch_sub(1, Ordering::SeqCst);
                        let _ = completed.send(());
                        return;
                    }
                };
                let capability = service.issue_capability(domain, instance, module);
                if initialization.send(Ok(())).is_err() {
                    owner_metrics.thread_live.store(false, Ordering::SeqCst);
                    LIVE_ASSET_OWNER_THREADS.fetch_sub(1, Ordering::SeqCst);
                    let _ = completed.send(());
                    return;
                }
                while let Ok(request) = requests.recv() {
                    owner_metrics.queued_requests.fetch_sub(1, Ordering::SeqCst);
                    match request {
                        AssetOwnerRequest::LeaseAndPrepare { request, reply } => {
                            let active = owner_metrics
                                .active_operations
                                .fetch_add(1, Ordering::SeqCst)
                                + 1;
                            owner_metrics
                                .maximum_active_operations
                                .fetch_max(active, Ordering::SeqCst);
                            let result = service
                                .lease(
                                    &capability,
                                    request.asset_id.as_str(),
                                    capability.instance_id(),
                                    "channel send",
                                    ASSET_LEASE_TTL_MS,
                                )
                                .and_then(|lease| {
                                    service.prepare_media(
                                        &capability,
                                        &MediaPrepareRequest {
                                            asset_id: request.asset_id,
                                            expected_media_kind: request.expected_media_kind,
                                            claimed_media_type: Some(request.claimed_media_type),
                                            lease_id: lease.lease_id,
                                        },
                                    )
                                })
                                .map_err(|error| AssetOwnerFailure {
                                    code: error.to_envelope().code,
                                });
                            owner_metrics
                                .active_operations
                                .fetch_sub(1, Ordering::SeqCst);
                            let _ = reply.send(result);
                        }
                        AssetOwnerRequest::Import { request, reply } => {
                            let active = owner_metrics
                                .active_operations
                                .fetch_add(1, Ordering::SeqCst)
                                + 1;
                            owner_metrics
                                .maximum_active_operations
                                .fetch_max(active, Ordering::SeqCst);
                            let result = service.import(&capability, &request).map_err(|error| {
                                AssetOwnerFailure {
                                    code: error.to_envelope().code,
                                }
                            });
                            owner_metrics
                                .active_operations
                                .fetch_sub(1, Ordering::SeqCst);
                            let _ = reply.send(result);
                        }
                        AssetOwnerRequest::Status { import_id, reply } => {
                            let active = owner_metrics
                                .active_operations
                                .fetch_add(1, Ordering::SeqCst)
                                + 1;
                            owner_metrics
                                .maximum_active_operations
                                .fetch_max(active, Ordering::SeqCst);
                            let result = service.status(&capability, &import_id).map_err(|error| {
                                AssetOwnerFailure {
                                    code: error.to_envelope().code,
                                }
                            });
                            owner_metrics
                                .active_operations
                                .fetch_sub(1, Ordering::SeqCst);
                            let _ = reply.send(result);
                        }
                        AssetOwnerRequest::Shutdown => break,
                    }
                }
                drop(service);
                owner_metrics.thread_live.store(false, Ordering::SeqCst);
                LIVE_ASSET_OWNER_THREADS.fetch_sub(1, Ordering::SeqCst);
                let _ = completed.send(());
            })
            .map_err(|_| HostRouteError::Rejected {
                code: "ASSET_OWNER_START_FAILED".to_string(),
                message: "the identity-scoped Asset owner thread could not start".to_string(),
            })?;
        Ok((
            Self {
                sender,
                completion: parking_lot::Mutex::new(completion),
                join: parking_lot::Mutex::new(Some(join)),
                shutdown_sent: AtomicBool::new(false),
                metrics,
                config_digest,
            },
            initialized,
        ))
    }

    fn send_until(
        &self,
        request: AssetOwnerRequest,
        deadline: Instant,
    ) -> Result<(), AssetOwnerCallError> {
        let mut pending = request;
        loop {
            match self.sender.try_send(pending) {
                Ok(()) => {
                    self.metrics.queued_requests.fetch_add(1, Ordering::SeqCst);
                    return Ok(());
                }
                Err(TrySendError::Full(request)) => {
                    pending = request;
                    if Instant::now() >= deadline {
                        return Err(AssetOwnerCallError::QueueTimeout);
                    }
                    std::thread::sleep(ASSET_OWNER_POLL_INTERVAL);
                }
                Err(TrySendError::Disconnected(_)) => {
                    return Err(AssetOwnerCallError::Disconnected);
                }
            }
        }
    }

    fn request_shutdown(&self, deadline: Instant) -> Result<(), HostRouteError> {
        if self
            .shutdown_sent
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(());
        }
        match self.send_until(AssetOwnerRequest::Shutdown, deadline) {
            Ok(()) | Err(AssetOwnerCallError::Disconnected) => Ok(()),
            Err(error) => {
                self.shutdown_sent.store(false, Ordering::Release);
                Err(owner_route_error(error.code()))
            }
        }
    }

    fn join_until(&self, deadline: Instant) -> Result<(), HostRouteError> {
        // Holding the join slot serializes concurrent shutdown/retry callers:
        // only one receiver consumes completion and joins the thread.
        let mut join_slot = self.join.lock();
        if join_slot.is_none() {
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(owner_route_error("ASSET_OWNER_SHUTDOWN_TIMEOUT"));
        }
        self.completion
            .lock()
            .recv_timeout(remaining)
            .map_err(|_| owner_route_error("ASSET_OWNER_SHUTDOWN_TIMEOUT"))?;
        let join = join_slot.take().expect("owner join handle present");
        join.join()
            .map_err(|_| owner_route_error("ASSET_OWNER_THREAD_PANICKED"))
    }

    fn request<T>(
        &self,
        command: AssetOwnerRequest,
        reply: Receiver<Result<T, AssetOwnerFailure>>,
    ) -> Result<T, AssetOwnerCallError> {
        self.send_until(command, Instant::now() + ASSET_OWNER_ENQUEUE_TIMEOUT)?;
        match reply.recv_timeout(ASSET_OWNER_REPLY_TIMEOUT) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(failure)) => Err(AssetOwnerCallError::Asset(failure)),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(AssetOwnerCallError::ReplyTimeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(AssetOwnerCallError::Disconnected),
        }
    }

    fn lease_and_prepare(
        &self,
        request: LeaseAndPrepareRequest,
    ) -> Result<PreparedMedia, AssetOwnerCallError> {
        let (reply, response) = mpsc::sync_channel(1);
        self.request(
            AssetOwnerRequest::LeaseAndPrepare { request, reply },
            response,
        )
    }

    fn import(&self, request: ImportRequest) -> Result<StatusResult, AssetOwnerCallError> {
        let (reply, response) = mpsc::sync_channel(1);
        self.request(AssetOwnerRequest::Import { request, reply }, response)
    }

    fn status(&self, import_id: String) -> Result<StatusResult, AssetOwnerCallError> {
        let (reply, response) = mpsc::sync_channel(1);
        self.request(AssetOwnerRequest::Status { import_id, reply }, response)
    }
}

fn owner_route_error(code: &str) -> HostRouteError {
    HostRouteError::Rejected {
        code: code.to_string(),
        message: "the identity-scoped Asset owner failed closed".to_string(),
    }
}

/// One real owner for one sealed Asset route identity. The owner thread creates
/// and retains the non-`Send` Asset service and capability. Route handles hold
/// only this typed bounded request endpoint.
pub(crate) struct AssetRouteRegistration {
    facts: AssetRouteFacts,
    owner: AssetOwnerThread,
    lifecycle: parking_lot::Mutex<AssetRouteLifecycle>,
    lifecycle_changed: parking_lot::Condvar,
    registered: bool,
}

/// One counted route/adapter handle. Dropping the final handle of a closing
/// registration performs bounded shutdown and removes the joined registration.
pub(crate) struct AssetRouteHandle {
    registration: Arc<AssetRouteRegistration>,
}

impl Drop for AssetRouteHandle {
    fn drop(&mut self) {
        self.registration.release_handle();
    }
}

impl AssetRouteRegistration {
    fn state(&self) -> AssetOwnerState {
        self.lifecycle.lock().state
    }

    fn wait_while_starting(&self, deadline: Instant) {
        let mut lifecycle = self.lifecycle.lock();
        while lifecycle.state == AssetOwnerState::Starting {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            self.lifecycle_changed.wait_for(&mut lifecycle, remaining);
        }
    }

    fn owner_config_matches(&self) -> bool {
        self.owner.config_digest == self.facts.config_identity.digest
    }

    fn activate(self: &Arc<Self>) -> Result<AssetRouteHandle, HostRouteError> {
        if !self.owner_config_matches() {
            return Err(owner_route_error("ASSET_OWNER_CONFIG_IDENTITY_MISMATCH"));
        }
        let mut lifecycle = self.lifecycle.lock();
        if lifecycle.state != AssetOwnerState::Starting {
            return Err(owner_route_error("ASSET_OWNER_CLOSED"));
        }
        lifecycle.state = AssetOwnerState::Active;
        lifecycle.live_handles = 1;
        self.lifecycle_changed.notify_all();
        Ok(AssetRouteHandle {
            registration: Arc::clone(self),
        })
    }

    fn open_handle(self: &Arc<Self>) -> Result<AssetRouteHandle, HostRouteError> {
        if !self.owner_config_matches() {
            return Err(owner_route_error("ASSET_OWNER_CONFIG_IDENTITY_MISMATCH"));
        }
        let mut lifecycle = self.lifecycle.lock();
        if lifecycle.state != AssetOwnerState::Active {
            return Err(owner_route_error("ASSET_OWNER_CLOSED"));
        }
        lifecycle.live_handles += 1;
        Ok(AssetRouteHandle {
            registration: Arc::clone(self),
        })
    }

    fn begin_close(self: &Arc<Self>) -> bool {
        let stop_now = {
            let mut lifecycle = self.lifecycle.lock();
            if lifecycle.state != AssetOwnerState::Active {
                return false;
            }
            lifecycle.state = AssetOwnerState::Closing;
            self.lifecycle_changed.notify_all();
            if lifecycle.live_handles == 0 {
                lifecycle.state = AssetOwnerState::Stopping;
                true
            } else {
                false
            }
        };
        if stop_now {
            let _ = self.stop_and_join(Instant::now() + ASSET_OWNER_SHUTDOWN_TIMEOUT);
        }
        true
    }

    fn begin_global_close(&self) {
        let mut lifecycle = self.lifecycle.lock();
        if matches!(
            lifecycle.state,
            AssetOwnerState::Starting | AssetOwnerState::Active | AssetOwnerState::Closing
        ) {
            lifecycle.state = AssetOwnerState::Stopping;
            self.lifecycle_changed.notify_all();
        }
    }

    fn release_handle(self: &Arc<Self>) {
        let stop_now = {
            let mut lifecycle = self.lifecycle.lock();
            lifecycle.live_handles = lifecycle
                .live_handles
                .checked_sub(1)
                .expect("Asset route handle count cannot underflow");
            if lifecycle.live_handles == 0
                && (lifecycle.state == AssetOwnerState::Closing
                    || (!self.registered && lifecycle.state == AssetOwnerState::Active))
            {
                lifecycle.state = AssetOwnerState::Stopping;
                true
            } else {
                false
            }
        };
        if stop_now {
            let _ = self.stop_and_join(Instant::now() + ASSET_OWNER_SHUTDOWN_TIMEOUT);
        } else {
            self.remove_if_closed_and_unused();
        }
    }

    fn can_finish_close(&self) -> bool {
        let mut lifecycle = self.lifecycle.lock();
        if lifecycle.live_handles != 0 {
            return false;
        }
        match lifecycle.state {
            AssetOwnerState::Closing => {
                lifecycle.state = AssetOwnerState::Stopping;
                true
            }
            AssetOwnerState::Stopping | AssetOwnerState::Closed => true,
            AssetOwnerState::Starting | AssetOwnerState::Active => false,
        }
    }

    fn request_stop(&self, deadline: Instant) -> Result<(), HostRouteError> {
        self.owner.request_shutdown(deadline)
    }

    fn stop_and_join(self: &Arc<Self>, deadline: Instant) -> Result<(), HostRouteError> {
        self.owner.request_shutdown(deadline)?;
        let result = self.owner.join_until(deadline);
        if !matches!(
            result,
            Err(HostRouteError::Rejected { ref code, .. })
                if code == "ASSET_OWNER_SHUTDOWN_TIMEOUT"
        ) {
            let mut lifecycle = self.lifecycle.lock();
            lifecycle.state = AssetOwnerState::Closed;
            self.lifecycle_changed.notify_all();
        }
        self.remove_if_closed_and_unused();
        result
    }

    fn remove_if_closed_and_unused(self: &Arc<Self>) {
        if !self.registered {
            return;
        }
        let removable = {
            let lifecycle = self.lifecycle.lock();
            lifecycle.state == AssetOwnerState::Closed && lifecycle.live_handles == 0
        };
        if !removable {
            return;
        }
        let mut registry = asset_route_registry().lock();
        if registry
            .entries
            .get(&self.facts.key)
            .is_some_and(|entry| std::ptr::eq(Arc::as_ptr(entry), Arc::as_ptr(self)))
        {
            registry.entries.remove(&self.facts.key);
        }
    }

    fn call_lease_and_prepare(
        &self,
        request: LeaseAndPrepareRequest,
    ) -> Result<PreparedMedia, AssetOwnerCallError> {
        let lifecycle = self.lifecycle.lock();
        if lifecycle.state != AssetOwnerState::Active {
            return Err(AssetOwnerCallError::Closed);
        }
        self.owner.lease_and_prepare(request)
    }

    fn call_import(&self, request: ImportRequest) -> Result<StatusResult, AssetOwnerCallError> {
        let lifecycle = self.lifecycle.lock();
        if lifecycle.state != AssetOwnerState::Active {
            return Err(AssetOwnerCallError::Closed);
        }
        self.owner.import(request)
    }

    fn call_status(&self, import_id: String) -> Result<StatusResult, AssetOwnerCallError> {
        let lifecycle = self.lifecycle.lock();
        if lifecycle.state != AssetOwnerState::Active {
            return Err(AssetOwnerCallError::Closed);
        }
        self.owner.status(import_id)
    }
}

impl AssetRouteHandle {
    fn try_clone(&self) -> Result<Self, HostRouteError> {
        self.registration.open_handle()
    }

    fn instance_id(&self) -> String {
        self.registration.facts.instance_id.clone()
    }

    fn module_id(&self) -> &str {
        &self.registration.facts.key.module_id
    }

    pub(crate) fn unregister(&self) -> bool {
        self.registration.begin_close()
    }

    #[cfg(test)]
    fn same_registration(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.registration, &other.registration)
    }

    #[cfg(test)]
    fn config_identity(&self) -> &AssetRouteConfigIdentity {
        &self.registration.facts.config_identity
    }
}

struct AssetRouteRegistry {
    accepting: bool,
    entries: std::collections::HashMap<AssetRouteKey, Arc<AssetRouteRegistration>>,
    #[cfg(test)]
    owners_created: usize,
}

impl Default for AssetRouteRegistry {
    fn default() -> Self {
        Self {
            accepting: true,
            entries: std::collections::HashMap::new(),
            #[cfg(test)]
            owners_created: 0,
        }
    }
}

static ASSET_ROUTE_REGISTRY: std::sync::LazyLock<parking_lot::Mutex<AssetRouteRegistry>> =
    std::sync::LazyLock::new(|| parking_lot::Mutex::new(AssetRouteRegistry::default()));

fn asset_route_registry() -> &'static parking_lot::Mutex<AssetRouteRegistry> {
    &ASSET_ROUTE_REGISTRY
}

/// The sealed Channel principal of the current authority/grant.
fn route_principal(
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
) -> Result<dolly_channel::ChannelPrincipal, HostRouteError> {
    dolly_channel::ChannelPrincipal::from_authority_grant(authority, grant).map_err(|error| {
        HostRouteError::Rejected {
            code: error.code,
            message: error.message,
        }
    })
}

/// A canonical absolute form of the content root used only at registration.
fn asset_root_key(root: &std::path::Path) -> String {
    std::path::absolute(root)
        .ok()
        .and_then(|absolute| absolute.canonicalize().ok().or(Some(absolute)))
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned())
}

fn asset_route_config_identity(
    config_revision: i64,
    config: &ResolvedAssetConfig,
) -> Result<AssetRouteConfigIdentity, HostRouteError> {
    config
        .validate()
        .map_err(|detail| HostRouteError::CapabilityDenied {
            detail: format!("asset config invalid: {detail}"),
        })?;
    let (canonical_jcs, digest) =
        dolly_canonical_json::canonicalize(&AssetRouteConfigIdentityInput {
            config_revision,
            resolved_asset_config: config,
        })
        .map_err(|_| HostRouteError::CapabilityDenied {
            detail: "resolved Asset config cannot form a canonical configuration identity".into(),
        })?;
    Ok(AssetRouteConfigIdentity {
        canonical_jcs,
        digest,
    })
}

fn asset_route_facts(
    principal: &dolly_channel::ChannelPrincipal,
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    config_revision: i64,
    config: &ResolvedAssetConfig,
    config_identity: AssetRouteConfigIdentity,
) -> Result<AssetRouteFacts, HostRouteError> {
    let instance_id = format!("i{}", authority.worker_epoch());
    if instance_id
        .parse::<dolly_core_domain::InstanceId>()
        .is_err()
    {
        return Err(HostRouteError::CapabilityDenied {
            detail: "sealed worker epoch cannot form a stable instance identifier".into(),
        });
    }
    Ok(AssetRouteFacts {
        key: AssetRouteKey {
            extension_connection_id: authority.extension_connection_id().to_owned(),
            worker_epoch: authority.worker_epoch().to_string(),
            extension_id: principal.extension_id().to_string(),
            module_id: principal.module_id().to_string(),
            config_revision,
            principal_account: principal.account().to_string(),
        },
        instance_id,
        extension_generation: grant.extension_generation(),
        root_key: asset_root_key(&config.local_root),
        config_identity,
    })
}

fn finish_failed_start(
    registration: &Arc<AssetRouteRegistration>,
    code: &str,
) -> Result<AssetRouteHandle, HostRouteError> {
    registration.begin_global_close();
    let _ = registration.stop_and_join(Instant::now() + ASSET_OWNER_SHUTDOWN_TIMEOUT);
    Err(owner_route_error(code))
}

/// Register or share one identity-scoped owner. `AssetService` and its
/// capability are created inside that owner thread exactly once.
pub(crate) fn asset_route_register(
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    config_revision: i64,
    config: ResolvedAssetConfig,
) -> Result<AssetRouteHandle, HostRouteError> {
    if !grant.allows("host.asset.import") || !grant.allows("host.asset.status") {
        return Err(HostRouteError::CapabilityDenied {
            detail: "the multimodal Channel route requires host.asset.import and host.asset.status grants under the same authority".into(),
        });
    }
    let principal = route_principal(authority, grant)?;
    let config_identity = asset_route_config_identity(config_revision, &config)?;
    let bound_config = BoundAssetConfig {
        resolved: config,
        identity: config_identity.clone(),
    };
    let facts = asset_route_facts(
        &principal,
        authority,
        grant,
        config_revision,
        &bound_config.resolved,
        config_identity,
    )?;
    loop {
        let existing = {
            let registry = asset_route_registry().lock();
            if !registry.accepting {
                return Err(owner_route_error("ASSET_OWNER_REGISTRY_SHUT_DOWN"));
            }
            registry.entries.get(&facts.key).cloned()
        };
        if let Some(existing) = existing {
            let state = existing.state();
            if state == AssetOwnerState::Starting {
                if existing.facts != facts {
                    return Err(HostRouteError::CapabilityDenied {
                        detail: "registration identity mismatch while the Asset owner is starting"
                            .into(),
                    });
                }
                existing.wait_while_starting(Instant::now() + ASSET_OWNER_REPLY_TIMEOUT);
                continue;
            }
            // A prior bounded stop may have completed just after its caller's
            // deadline. With no route handles, finish the safe join/remove
            // before considering a replacement generation.
            if existing.can_finish_close() {
                existing.stop_and_join(Instant::now() + ASSET_OWNER_SHUTDOWN_TIMEOUT)?;
                continue;
            }
            if existing.facts != facts {
                return Err(HostRouteError::CapabilityDenied {
                    detail: "registration identity mismatch (a different Asset root, extension generation, or complete resolved configuration is already registered for this store/account/config identity)".into(),
                });
            }
            return match state {
                AssetOwnerState::Active => existing.open_handle(),
                AssetOwnerState::Closing | AssetOwnerState::Stopping | AssetOwnerState::Closed => {
                    Err(owner_route_error("ASSET_OWNER_CLOSING"))
                }
                AssetOwnerState::Starting => unreachable!("starting handled above"),
            };
        }

        let (registration, initialized) = {
            let mut registry = asset_route_registry().lock();
            if !registry.accepting {
                return Err(owner_route_error("ASSET_OWNER_REGISTRY_SHUT_DOWN"));
            }
            if registry.entries.contains_key(&facts.key) {
                continue;
            }
            // Hold the registry lock through thread creation and insertion.
            // The new owner is recorded as Starting before any concurrent
            // registration can decide to create another owner.
            let (owner, initialized) = AssetOwnerThread::spawn(bound_config.clone(), &facts)?;
            #[cfg(test)]
            {
                registry.owners_created += 1;
            }
            let registration = Arc::new(AssetRouteRegistration {
                facts: facts.clone(),
                owner,
                lifecycle: parking_lot::Mutex::new(AssetRouteLifecycle {
                    state: AssetOwnerState::Starting,
                    live_handles: 0,
                }),
                lifecycle_changed: parking_lot::Condvar::new(),
                registered: true,
            });
            registry
                .entries
                .insert(facts.key.clone(), Arc::clone(&registration));
            (registration, initialized)
        };
        return match initialized.recv_timeout(ASSET_OWNER_REPLY_TIMEOUT) {
            Ok(Ok(())) => registration.activate(),
            Ok(Err(failure)) => finish_failed_start(&registration, &failure.code),
            Err(_) => finish_failed_start(&registration, "ASSET_OWNER_START_TIMEOUT"),
        };
    }
}

/// Open the exact active owner already registered for this sealed identity and
/// complete canonical resolved configuration. A matching revision or root is
/// insufficient when any serialized configuration field differs.
pub(crate) fn asset_route_open(
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    config_revision: i64,
    config: &ResolvedAssetConfig,
) -> Result<AssetRouteHandle, HostRouteError> {
    let principal = route_principal(authority, grant)?;
    let config_identity = asset_route_config_identity(config_revision, config)?;
    let facts = asset_route_facts(
        &principal,
        authority,
        grant,
        config_revision,
        config,
        config_identity,
    )?;
    let registration = asset_route_registry()
        .lock()
        .entries
        .get(&facts.key)
        .cloned()
        .ok_or_else(|| HostRouteError::CapabilityDenied {
            detail: "no Asset route is registered for this store/account/config identity; register the outbound Asset route first".into(),
        })?;
    if registration.facts != facts {
        return Err(HostRouteError::CapabilityDenied {
            detail: "registered Asset owner does not match the current generation, root, or complete resolved configuration identity".into(),
        });
    }
    registration.open_handle()
}

/// Mark one registration closing. It stays in the registry until every live
/// handle drops and the owner joins, so same-identity re-registration cannot
/// overlap the old service or capability.
#[cfg(test)]
pub(crate) fn asset_route_unregister(
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    config_revision: i64,
) -> Result<bool, HostRouteError> {
    let principal = route_principal(authority, grant)?;
    let key = AssetRouteKey {
        extension_connection_id: authority.extension_connection_id().to_owned(),
        worker_epoch: authority.worker_epoch().to_string(),
        extension_id: principal.extension_id().to_string(),
        module_id: principal.module_id().to_string(),
        config_revision,
        principal_account: principal.account().to_string(),
    };
    let registration = asset_route_registry().lock().entries.get(&key).cloned();
    Ok(registration.is_some_and(|registration| registration.begin_close()))
}

/// Process shutdown closes admission first, marks every handle closed, queues
/// one shutdown command per owner, then joins within one global bound. Joined
/// entries remain only while a counted closed route handle is still live.
pub(crate) fn asset_route_shutdown() -> Result<(), HostRouteError> {
    let registrations = {
        let mut registry = asset_route_registry().lock();
        registry.accepting = false;
        registry.entries.values().cloned().collect::<Vec<_>>()
    };
    let deadline = Instant::now() + ASSET_OWNER_SHUTDOWN_TIMEOUT;
    let mut first_error = None;
    for registration in &registrations {
        registration.begin_global_close();
    }
    for registration in &registrations {
        if let Err(error) = registration.request_stop(deadline) {
            first_error.get_or_insert(error);
        }
    }
    for registration in &registrations {
        if let Err(error) = registration.stop_and_join(deadline) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

#[cfg(test)]
fn asset_route_registry_len() -> usize {
    asset_route_registry().lock().entries.len()
}

#[cfg(test)]
fn asset_route_owners_created() -> usize {
    asset_route_registry().lock().owners_created
}

#[cfg(test)]
fn test_asset_route(
    config: ResolvedAssetConfig,
    domain: &str,
    instance: &str,
    module: &str,
) -> Result<AssetRouteHandle, HostRouteError> {
    let config_identity = asset_route_config_identity(1, &config)?;
    let bound_config = BoundAssetConfig {
        resolved: config,
        identity: config_identity.clone(),
    };
    let facts = AssetRouteFacts {
        key: AssetRouteKey {
            extension_connection_id: domain.to_string(),
            worker_epoch: instance.to_string(),
            extension_id: "test-extension".to_string(),
            module_id: module.to_string(),
            config_revision: 1,
            principal_account: "test-account".to_string(),
        },
        instance_id: instance.to_string(),
        extension_generation: 1,
        root_key: asset_root_key(&bound_config.resolved.local_root),
        config_identity,
    };
    let (owner, initialized) = AssetOwnerThread::spawn(bound_config, &facts)?;
    let registration = Arc::new(AssetRouteRegistration {
        facts,
        owner,
        lifecycle: parking_lot::Mutex::new(AssetRouteLifecycle {
            state: AssetOwnerState::Starting,
            live_handles: 0,
        }),
        lifecycle_changed: parking_lot::Condvar::new(),
        registered: false,
    });
    match initialized.recv_timeout(ASSET_OWNER_REPLY_TIMEOUT) {
        Ok(Ok(())) => registration.activate(),
        Ok(Err(failure)) => finish_failed_start(&registration, &failure.code),
        Err(_) => finish_failed_start(&registration, "ASSET_OWNER_START_TIMEOUT"),
    }
}

/// The finite short Asset lease the outbound adapter holds per prepared
/// premise (the frozen "short Asset lease" of the multimodal profile).
const ASSET_LEASE_TTL_MS: u64 = 30_000;

/// Redacted fail-closed refusal for one asset part. Only the ordinal and the
/// Asset envelope code are surfaced; the content root, path, capability, and
/// raw cause never leave the Asset authority.
fn asset_refused(ordinal: u32, code: &str) -> ChannelError {
    ChannelError::new(
        codes::ASSET_IMPORT_FAILED,
        false,
        ChannelOutcome::NotApplied,
        format!(
            "asset authority refused asset part at ordinal {ordinal} (code {code}); the committed AssetId cannot be prepared"
        ),
    )
}

fn attachment_refused(provider_key: &str, detail: &str) -> ChannelError {
    ChannelError::new(
        codes::ASSET_IMPORT_FAILED,
        false,
        ChannelOutcome::NotApplied,
        format!("attachment import refused for provider key {provider_key}: {detail}"),
    )
}

fn asset_kind_of_type(media_type: &ChannelMediaType) -> MediaKind {
    if media_type.as_str().starts_with("image/") {
        MediaKind::Image
    } else if media_type.as_str().starts_with("audio/") {
        MediaKind::Audio
    } else if media_type.as_str().starts_with("video/") {
        MediaKind::Video
    } else {
        MediaKind::File
    }
}

fn channel_kind_of_type(kind: MediaKind) -> ChannelMediaKind {
    match kind {
        MediaKind::Image => ChannelMediaKind::Image,
        MediaKind::Audio => ChannelMediaKind::Audio,
        MediaKind::Video => ChannelMediaKind::Video,
        MediaKind::File => ChannelMediaKind::File,
    }
}

fn now_unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
/// Strict canonical base64 (RFC 4648 alphabet, terminal `=` padding),
/// matching the Asset `InlineBase64` wire contract.
fn strict_base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut index = 0usize;
    while index + 3 <= bytes.len() {
        let value = u32::from(bytes[index]) << 16
            | u32::from(bytes[index + 1]) << 8
            | u32::from(bytes[index + 2]);
        out.push(ALPHABET[(value >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(value >> 12) as usize & 0x3f] as char);
        out.push(ALPHABET[(value >> 6) as usize & 0x3f] as char);
        out.push(ALPHABET[value as usize & 0x3f] as char);
        index += 3;
    }
    let remaining = bytes.len() - index;
    if remaining == 1 {
        let value = u32::from(bytes[index]) << 16;
        out.push(ALPHABET[(value >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(value >> 12) as usize & 0x3f] as char);
        out.push('=');
        out.push('=');
    } else if remaining == 2 {
        let value = u32::from(bytes[index]) << 16 | u32::from(bytes[index + 1]) << 8;
        out.push(ALPHABET[(value >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(value >> 12) as usize & 0x3f] as char);
        out.push(ALPHABET[(value >> 6) as usize & 0x3f] as char);
        out.push('=');
    }
    let _ = dolly_asset::source::strict_base64_decoded_len(&out)
        .expect("strict base64 encoder output must be canonical");
    out
}

/// One RFC3339 deadline string for Asset wire requests, derived from the
/// current monotonic instant.
fn wire_deadline_after(seconds: u64) -> String {
    dolly_asset::clock::format_timestamp(now_unix_millis() + seconds * 1000)
}

// ---------------------------------------------------------------------------
// Outbound: prepare_assets under the exact Asset capability and lease.
// ---------------------------------------------------------------------------

/// The Runtime's one outbound Asset preparation seam. Unbound by default
/// (fail closed on every asset part); a bound seam holds one counted handle
/// to the identity-scoped Asset owner.
pub struct ChannelAssetSeam {
    owner: Option<AssetRouteHandle>,
}

impl ChannelAssetSeam {
    /// The fail-closed seam: no Asset owner is bound to the route.
    pub fn unbound() -> Self {
        Self { owner: None }
    }

    /// Acquire one live handle to the route's single owner. A closing or
    /// closed registration refuses this open even when the route still holds
    /// its original handle.
    pub(crate) fn from_registration(
        registration: &AssetRouteHandle,
    ) -> Result<Self, HostRouteError> {
        Ok(Self {
            owner: Some(registration.try_clone()?),
        })
    }

    /// Test support creates the service and capability inside an unregistered
    /// owner thread; no service or capability crosses the thread boundary.
    #[cfg(test)]
    fn for_test(
        config: ResolvedAssetConfig,
        domain: &str,
        instance: &str,
        module: &str,
    ) -> Result<Self, HostRouteError> {
        Ok(Self {
            owner: Some(test_asset_route(config, domain, instance, module)?),
        })
    }
}

impl AssetPreparation for ChannelAssetSeam {
    fn prepare_assets(
        &mut self,
        premises: &[AssetPremise],
    ) -> Result<Vec<AssetPayload>, ChannelError> {
        let Some(owner) = self.owner.as_ref() else {
            if let Some(first) = premises.first() {
                return Err(asset_refused(first.ordinal, "NO_ASSET_OWNER"));
            }
            return Ok(Vec::new());
        };
        let mut payloads = Vec::with_capacity(premises.len());
        for premise in premises {
            let asset_id = premise
                .asset_id
                .as_str()
                .parse()
                .map_err(|_| asset_refused(premise.ordinal, "NONCANONICAL_ASSET_ID"))?;
            let claimed_media_type = premise
                .media_type
                .as_str()
                .parse()
                .map_err(|_| asset_refused(premise.ordinal, "INVALID_MEDIA_TYPE"))?;
            let prepared = owner
                .registration
                .call_lease_and_prepare(LeaseAndPrepareRequest {
                    asset_id,
                    expected_media_kind: asset_kind_of_type(&premise.media_type),
                    claimed_media_type,
                })
                .map_err(|error| asset_refused(premise.ordinal, error.code()))?;
            payloads.push(convert_prepared_media(premise.ordinal, prepared)?);
        }
        Ok(payloads)
    }
}

/// Field-for-field mirror of the accepted Asset `PreparedMedia` into the
/// closed Channel `AssetPayload`. The ephemeral byte buffer is MOVED into the
/// payload (never copied), and every reference field is the value the Asset
/// service minted from the durable row; no caller metadata is echoed and no
/// absent geometry is fabricated.
fn convert_prepared_media(
    ordinal: u32,
    prepared: PreparedMedia,
) -> Result<AssetPayload, ChannelError> {
    let PreparedMedia {
        asset_ref,
        media_kind,
        generation,
        digest,
        lease_id,
        lease_expires_at_ms,
        bytes,
    } = prepared;
    let asset_ref = ChannelAssetRef {
        asset_id: ChannelAssetId::parse(asset_ref.asset_id.as_str())
            .map_err(|_| asset_refused(ordinal, "NONCANONICAL_ASSET_ID"))?,
        media_type: ChannelMediaType::parse(asset_ref.media_type.as_str())
            .map_err(|_| asset_refused(ordinal, "INVALID_MEDIA_TYPE"))?,
        byte_length: asset_ref.byte_length,
        orientation: asset_ref.orientation,
        encoded_width: asset_ref.encoded_width,
        encoded_height: asset_ref.encoded_height,
        display_width: asset_ref.display_width,
        display_height: asset_ref.display_height,
    };
    asset_ref.validate().map_err(|message| {
        ChannelError::new(
            codes::ASSET_IMPORT_FAILED,
            false,
            ChannelOutcome::NotApplied,
            format!("asset part at ordinal {ordinal} refused: {message}"),
        )
    })?;
    Ok(AssetPayload {
        asset_ref,
        media_kind: channel_kind_of_type(media_kind),
        generation,
        digest: ChannelContentHash::from_digest(digest.digest),
        lease_id,
        lease_expiry_unix_ms: lease_expires_at_ms,
        // The bounded immutable bytes are moved, never cloned.
        bytes,
    })
}

// ---------------------------------------------------------------------------
// Inbound: provider attachment -> explicit Asset import -> name-based status.
// ---------------------------------------------------------------------------

/// The Runtime's inbound attachment seam. A bound seam holds one counted
/// handle to the same identity-scoped owner as outbound and reconcile.
pub struct ChannelAttachmentImport {
    owner: Option<AssetRouteHandle>,
    /// The sealed Channel principal account this seam serves.
    account: String,
    /// The bounded authenticated provider attachment reader. Provider access
    /// stays on the caller side; only the resulting bounded bytes enter the
    /// typed Asset import request.
    provider: Option<Box<dyn ProviderAttachmentReader>>,
}

impl ChannelAttachmentImport {
    /// The fail-closed seam: attachments are refused before any durable or
    /// transport effect.
    pub fn unbound() -> Self {
        Self {
            owner: None,
            account: String::new(),
            provider: None,
        }
    }

    /// Bind the already registered owner and verify the exact sealed account,
    /// grants, generation, config revision, and canonical content root.
    pub fn bind(
        config: ResolvedAssetConfig,
        config_revision: i64,
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
        account: &str,
        provider: Box<dyn ProviderAttachmentReader>,
    ) -> Result<Self, HostRouteError> {
        if !grant.allows("host.asset.import") || !grant.allows("host.asset.status") {
            return Err(HostRouteError::CapabilityDenied {
                detail: "the grant does not authorize host.asset.import/host.asset.status".into(),
            });
        }
        let principal = route_principal(authority, grant)?;
        if principal.account() != account {
            return Err(HostRouteError::CapabilityDenied {
                detail: "caller account does not match the sealed Channel principal account".into(),
            });
        }
        // The open compares generation, canonical root, revision, and the JCS
        // identity of the complete resolved config before returning a handle.
        let owner = asset_route_open(authority, grant, config_revision, &config)?;
        Ok(Self {
            owner: Some(owner),
            account: account.to_string(),
            provider: Some(provider),
        })
    }

    /// Fail closed unless the attachment key is scoped to exactly this
    /// seam's bound account, before provider access or an Asset request.
    fn check_attachment_ownership(
        &self,
        request: &AttachmentImportRequest,
    ) -> Result<(), ChannelError> {
        let scoped = format!("{}\u{0}", self.account);
        if !request.attachment_key.starts_with(&scoped) {
            return Err(attachment_refused(
                &request.provider_key,
                "attachment key is not scoped to the bound Channel account",
            ));
        }
        Ok(())
    }

    /// Test support creates the service/capability inside an unregistered
    /// owner and binds the provider to a counted route handle.
    #[cfg(test)]
    fn for_test(
        config: ResolvedAssetConfig,
        domain: &str,
        instance: &str,
        module: &str,
        account: &str,
        provider: Box<dyn ProviderAttachmentReader>,
    ) -> Result<Self, HostRouteError> {
        Ok(Self {
            owner: Some(test_asset_route(config, domain, instance, module)?),
            account: account.to_string(),
            provider: Some(provider),
        })
    }

    #[cfg(test)]
    fn from_test_owner(
        owner: &AssetRouteHandle,
        account: &str,
        provider: Box<dyn ProviderAttachmentReader>,
    ) -> Result<Self, HostRouteError> {
        Ok(Self {
            owner: Some(owner.try_clone()?),
            account: account.to_string(),
            provider: Some(provider),
        })
    }

    fn import_id_for(&self, request: &AttachmentImportRequest) -> String {
        // Stable 128-bit UUID-v7-shaped id derived from the sealed account
        // and account-scoped idempotency key, preserving restart identity.
        let mut bytes = [0u8; 16];
        let mut seed = self.account.as_bytes().to_vec();
        seed.push(0);
        seed.extend_from_slice(request.attachment_key.as_bytes());
        let digest = blake3::hash(&seed);
        bytes.copy_from_slice(&digest.as_bytes()[0..16]);
        bytes[6] = (bytes[6] & 0x0f) | 0x70;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            u16::from_be_bytes([bytes[4], bytes[5]]),
            u16::from_be_bytes([bytes[6], bytes[7]]),
            u16::from_be_bytes([bytes[8], bytes[9]]),
            bytes[10],
            bytes[11],
            bytes[12],
            bytes[13],
            bytes[14],
            bytes[15],
        )
    }

    fn run_import(
        &mut self,
        request: &AttachmentImportRequest,
    ) -> Result<AttachmentImportStatus, ChannelError> {
        self.check_attachment_ownership(request)?;
        let import_id = self.import_id_for(request);
        let Some(owner) = self.owner.as_ref() else {
            return Err(attachment_refused(
                &request.provider_key,
                "no Asset owner is bound to the Channel inbound route",
            ));
        };
        let Some(reader) = self.provider.as_mut() else {
            return Err(attachment_refused(
                &request.provider_key,
                "no bounded provider reader is bound; provider bytes cannot be obtained",
            ));
        };
        let bytes = reader
            .read(&request.provider_key, request.byte_length_hint)
            .map_err(|detail| {
                attachment_refused(
                    &request.provider_key,
                    &format!("provider fetch refused: {detail}"),
                )
            })?;
        if bytes.len() as u64 > request.byte_length_hint {
            return Err(attachment_refused(
                &request.provider_key,
                "provider bytes exceed the closed declared byte bound",
            ));
        }
        let import_request = ImportRequest {
            import_id,
            instance_id: owner.instance_id(),
            module_id: owner.module_id().to_string(),
            activation_id: None,
            lease_token: None,
            media_kind: asset_kind_of_type(&request.declared_media_type),
            source: Source::InlineBase64 {
                base64: strict_base64_encode(&bytes),
            },
            declared_media_type: Some(request.declared_media_type.as_str().parse().map_err(
                |_| attachment_refused(&request.provider_key, "declared media type is invalid"),
            )?),
            remote_required: false,
            expected_byte_length: Some(bytes.len() as u64),
            deadline: wire_deadline_after(120),
        };
        owner
            .registration
            .call_import(import_request)
            .map(map_import_status)
            .map_err(|error| {
                attachment_refused(
                    &request.provider_key,
                    &format!("asset import refused (code {})", error.code()),
                )
            })
    }

    fn run_status(
        &mut self,
        request: &AttachmentImportRequest,
    ) -> Result<AttachmentImportStatus, ChannelError> {
        self.check_attachment_ownership(request)?;
        let import_id = self.import_id_for(request);
        let Some(owner) = self.owner.as_ref() else {
            return Err(attachment_refused(
                &request.provider_key,
                "no Asset owner is bound to the Channel inbound route",
            ));
        };
        owner
            .registration
            .call_status(import_id)
            .map(map_import_status)
            .map_err(|error| {
                attachment_refused(
                    &request.provider_key,
                    &format!("asset status refused (code {})", error.code()),
                )
            })
    }
}

/// Map the Asset authority's closed status result to the Channel
/// `AttachmentImportStatus`. `Absent` is emitted only for the Asset
/// authority's exact `absent` answer (no durable import record/effect);
/// every recorded in-progress and terminal state maps to its Channel
/// equivalent and is never fabricated as `Available`.
fn map_import_status(status: StatusResult) -> AttachmentImportStatus {
    match status.state.as_str() {
        "available" => match status.asset {
            Some(reference) => {
                let asset_ref = ChannelAssetRef {
                    asset_id: match ChannelAssetId::parse(reference.asset_id.as_str()) {
                        Ok(asset_id) => asset_id,
                        Err(_) => {
                            return AttachmentImportStatus::Refused {
                                code: "NONCANONICAL_ASSET_REF".to_string(),
                            };
                        }
                    },
                    media_type: match ChannelMediaType::parse(reference.media_type.as_str()) {
                        Ok(media_type) => media_type,
                        Err(_) => {
                            return AttachmentImportStatus::Refused {
                                code: "INVALID_MEDIA_TYPE".to_string(),
                            };
                        }
                    },
                    byte_length: reference.byte_length,
                    orientation: reference.orientation,
                    encoded_width: reference.encoded_width,
                    encoded_height: reference.encoded_height,
                    display_width: reference.display_width,
                    display_height: reference.display_height,
                };
                if let Err(message) = asset_ref.validate() {
                    return AttachmentImportStatus::Refused {
                        code: format!("NONCANONICAL_ASSET_REF: {message}"),
                    };
                }
                let media_kind = channel_kind_of_type(asset_kind_of_type(&asset_ref.media_type));
                AttachmentImportStatus::Available(AvailableAttachment {
                    asset_ref,
                    media_kind,
                    view: None,
                })
            }
            None => AttachmentImportStatus::Refused {
                code: "AVAILABLE_WITHOUT_ASSET_REF".to_string(),
            },
        },
        "absent" => AttachmentImportStatus::Absent,
        "rejected" | "cancelled" => AttachmentImportStatus::Refused {
            code: status
                .error
                .as_ref()
                .and_then(|error| error.get("code"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("IMPORT_REJECTED")
                .to_string(),
        },
        _ => AttachmentImportStatus::Pending,
    }
}

impl InboundAssetImport for ChannelAttachmentImport {
    fn import(
        &mut self,
        request: &AttachmentImportRequest,
    ) -> Result<AttachmentImportStatus, ChannelError> {
        self.run_import(request)
    }

    fn status(
        &mut self,
        request: &AttachmentImportRequest,
    ) -> Result<AttachmentImportStatus, ChannelError> {
        self.run_status(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(&[0, 0, 0, 13]);
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes.extend_from_slice(&[0u8; 24]);
        bytes
    }

    /// Deterministic bounded provider reader for tests: serves a fixed byte
    /// payload per key and records reads (bounded).
    #[derive(Default)]
    struct FakeProvider {
        payload: Option<Vec<u8>>,
    }

    impl FakeProvider {
        fn serving(bytes: Vec<u8>) -> Self {
            Self {
                payload: Some(bytes),
            }
        }
    }

    impl ProviderAttachmentReader for FakeProvider {
        fn read(&mut self, provider_key: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
            let payload = self
                .payload
                .clone()
                .ok_or_else(|| format!("no payload for {provider_key}"))?;
            if provider_key == "missing" {
                return Err("no provider object for key".to_string());
            }
            if payload.len() as u64 > max_bytes {
                return Err("provider payload exceeds the bound".to_string());
            }
            Ok(payload)
        }
    }

    fn config_at(root: &std::path::Path) -> ResolvedAssetConfig {
        let mut config = ResolvedAssetConfig::with_local_root(root.to_path_buf());
        config.max_decoded_bytes = 64 * 1024;
        config.max_inline_base64_chars = 128 * 1024;
        config.max_image_pixels = 1_000_000;
        config.gc_grace_ms = 60_000;
        config
    }

    fn import_request(id: &str, bytes: &[u8]) -> ImportRequest {
        ImportRequest {
            import_id: id.to_string(),
            instance_id: "instance-a".to_string(),
            module_id: "module-a".to_string(),
            activation_id: None,
            lease_token: None,
            media_kind: MediaKind::Image,
            source: Source::InlineBase64 {
                base64: strict_base64_encode(bytes),
            },
            declared_media_type: Some("image/png".parse().expect("valid type")),
            remote_required: false,
            expected_byte_length: Some(bytes.len() as u64),
            deadline: "2026-08-09T15:00:00.000000Z".to_string(),
        }
    }

    fn import_available(owner: &AssetRouteHandle, id: &str, bytes: &[u8]) -> String {
        let mut request = import_request(id, bytes);
        request.instance_id = owner.instance_id();
        request.module_id = owner.module_id().to_string();
        let imported = owner
            .registration
            .call_import(request)
            .expect("import succeeds through owner");
        assert_eq!(imported.state, "available", "import must be available");
        imported
            .asset
            .expect("asset ref")
            .asset_id
            .as_str()
            .to_string()
    }

    #[test]
    fn outbound_seam_prepares_media_field_for_field_under_a_lease() {
        let dir = tempfile::tempdir().expect("tempdir");
        let png = png_bytes(4, 2);
        let owner = test_asset_route(config_at(dir.path()), "domain-a", "instance-a", "module-a")
            .expect("test Asset owner");
        let asset_id = import_available(&owner, "0198ab31-6c44-7e8a-b2bb-000000000001", &png);
        let mut seam =
            ChannelAssetSeam::from_registration(&owner).expect("open shared owner handle");

        let premise = AssetPremise {
            ordinal: 0,
            asset_id: ChannelAssetId::parse(&asset_id).expect("canonical id"),
            media_type: ChannelMediaType::parse("image/png").expect("canonical type"),
            view: None,
        };
        let payloads = seam.prepare_assets(&[premise]).expect("prepare succeeds");
        assert_eq!(payloads.len(), 1, "one payload per premise");
        let payload = &payloads[0];
        // Field-for-field authoritative identity: the exact committed
        // content-addressed AssetId and detected media type.
        assert_eq!(payload.asset_ref.asset_id.as_str(), asset_id);
        assert_eq!(payload.asset_ref.media_type.as_str(), "image/png");
        assert_eq!(payload.asset_ref.byte_length, png.len() as u64);
        assert_eq!(payload.media_kind, ChannelMediaKind::Image);
        assert_eq!(payload.bytes, png, "verified immutable bytes");
        assert_eq!(payload.generation, 1, "current generation holds the lease");
        assert!(
            payload.lease_id.len() >= 32 && payload.lease_id != asset_id,
            "un-guessable finite lease token"
        );
        assert!(payload.lease_expiry_unix_ms > now_unix_millis());
        // Durable proof is exactly the payload minus the ephemeral bytes.
        let proof = payload.lease_proof();
        assert_eq!(proof.asset_ref, payload.asset_ref);
        assert_eq!(proof.digest.digest, payload.digest.digest);
    }

    #[test]
    fn outbound_seam_fails_closed_on_unavailable_and_unbound_assets() {
        let dir = tempfile::tempdir().expect("tempdir");
        let png = png_bytes(4, 2);
        let config = config_at(dir.path());
        let owner = test_asset_route(config.clone(), "domain-a", "instance-a", "module-a")
            .expect("test Asset owner");
        let asset_id = import_available(&owner, "0198ab31-6c44-7e8a-b2bb-000000000002", &png);

        let premise = |asset: &str| AssetPremise {
            ordinal: 0,
            asset_id: ChannelAssetId::parse(asset).expect("canonical id"),
            media_type: ChannelMediaType::parse("image/png").expect("canonical type"),
            view: None,
        };

        // A never-imported but canonical id is refused by the asset authority
        // with the Channel asset code and no path disclosure.
        let forged = "ast_b3_".to_string() + &"a".repeat(52);
        let mut seam =
            ChannelAssetSeam::from_registration(&owner).expect("open shared owner handle");
        let refused = seam.prepare_assets(&[premise(&forged)]);
        match refused {
            Err(error) => {
                assert_eq!(error.code, codes::ASSET_IMPORT_FAILED);
                assert_eq!(error.outcome, ChannelOutcome::NotApplied);
                let root = dir.path().to_str().unwrap();
                assert!(
                    !error.message.contains(root),
                    "the content root must never leak into the error surface"
                );
            }
            Ok(_) => panic!("unavailable asset must fail closed"),
        }

        // A distinct foreign-domain owner cannot prepare the identical
        // durable asset. Drop the first owner before opening the next service.
        drop(seam);
        drop(owner);
        let mut foreign_seam =
            ChannelAssetSeam::for_test(config, "other-domain", "instance-a", "module-a")
                .expect("foreign owner starts");
        let cross_domain = foreign_seam.prepare_assets(&[premise(&asset_id)]);
        match cross_domain {
            Err(error) => {
                assert_eq!(error.code, codes::ASSET_IMPORT_FAILED);
                assert_eq!(error.outcome, ChannelOutcome::NotApplied);
            }
            Ok(_) => panic!("cross-domain lease must fail closed"),
        }
    }

    #[test]
    fn unbound_outbound_seam_fails_closed_with_an_asset_code() {
        let mut seam = ChannelAssetSeam::unbound();
        let premise = AssetPremise {
            ordinal: 0,
            asset_id: ChannelAssetId::parse(&("ast_b3_".to_string() + &"a".repeat(52)))
                .expect("canonical id"),
            media_type: ChannelMediaType::parse("image/png").expect("canonical type"),
            view: None,
        };
        let err = seam
            .prepare_assets(&[premise])
            .expect_err("unbound refuses");
        assert_eq!(err.code, codes::ASSET_IMPORT_FAILED);
        assert_eq!(err.outcome, ChannelOutcome::NotApplied);
        assert!(
            seam.prepare_assets(&[]).unwrap().is_empty(),
            "no premises -> no work"
        );
    }

    #[test]
    fn inbound_seam_imports_available_and_reports_absent_for_unknown_keys() {
        let dir = tempfile::tempdir().expect("tempdir");
        let png = png_bytes(4, 2);
        let mut seam = ChannelAttachmentImport::for_test(
            config_at(dir.path()),
            "domain-a",
            "instance-a",
            "module-a",
            "account-a",
            Box::new(FakeProvider::serving(png.clone())),
        )
        .expect("inbound owner starts");

        let request = AttachmentImportRequest::new(
            "account-a",
            "evt-1",
            &dolly_channel::attachment::InboundAttachment {
                ordinal: 0,
                provider_key: "provider-blob-1".to_string(),
                media_kind: ChannelMediaKind::Image,
                declared_media_type: ChannelMediaType::parse("image/png").expect("type"),
                byte_length_hint: png.len() as u64,
            },
        );
        match seam.import(&request).expect("import runs") {
            AttachmentImportStatus::Available(available) => {
                assert_eq!(available.asset_ref.media_type.as_str(), "image/png");
                assert_eq!(available.asset_ref.byte_length, png.len() as u64);
                assert_eq!(available.media_kind, ChannelMediaKind::Image);
            }
            other => panic!("expected Available, got {other:?}"),
        }
        // Authoritative absent only for a key with no durable import record.
        let unknown = AttachmentImportRequest::new(
            "account-a",
            "nope",
            &dolly_channel::attachment::InboundAttachment {
                ordinal: 1,
                provider_key: "never-imported".to_string(),
                media_kind: ChannelMediaKind::Image,
                declared_media_type: ChannelMediaType::parse("image/png").expect("type"),
                byte_length_hint: 4,
            },
        );
        match seam.status(&unknown).expect("status runs") {
            AttachmentImportStatus::Absent => {}
            other => panic!("expected Absent, got {other:?}"),
        }
    }

    #[test]
    fn inbound_seam_refuses_foreign_account_and_missing_provider_before_import() {
        let dir = tempfile::tempdir().expect("tempdir");
        let png = png_bytes(4, 2);
        let mut seam = ChannelAttachmentImport::for_test(
            config_at(dir.path()),
            "domain-a",
            "instance-a",
            "module-a",
            "account-a",
            Box::new(FakeProvider::serving(png.clone())),
        )
        .expect("inbound owner starts");

        // A key scoped to a different account is refused before any provider
        // read or Asset call (mismatch rejection, exact-key/domain binding).
        let foreign = AttachmentImportRequest::new(
            "account-b",
            "evt-f",
            &dolly_channel::attachment::InboundAttachment {
                ordinal: 0,
                provider_key: "provider-foreign".to_string(),
                media_kind: ChannelMediaKind::Image,
                declared_media_type: ChannelMediaType::parse("image/png").expect("type"),
                byte_length_hint: png.len() as u64,
            },
        );
        let err = seam
            .import(&foreign)
            .expect_err("foreign account must refuse");
        assert_eq!(err.code, codes::ASSET_IMPORT_FAILED);
        assert_eq!(err.outcome, ChannelOutcome::NotApplied);
        // No provider read happened and no durable import record exists.
        let err = seam
            .status(&foreign)
            .expect_err("foreign account must refuse status");
        assert_eq!(err.code, codes::ASSET_IMPORT_FAILED);

        // A provider that cannot serve the authenticated key fails closed
        // before any Asset record, with zero duplicate effect.
        let other_dir = tempfile::tempdir().expect("other tempdir");
        let mut on_missing = ChannelAttachmentImport::for_test(
            config_at(other_dir.path()),
            "domain-b",
            "instance-a",
            "module-a",
            "account-a",
            Box::new(FakeProvider::default()),
        )
        .expect("missing-provider owner starts");
        let missing = AttachmentImportRequest::new(
            "account-a",
            "evt-m",
            &dolly_channel::attachment::InboundAttachment {
                ordinal: 0,
                provider_key: "missing".to_string(),
                media_kind: ChannelMediaKind::Image,
                declared_media_type: ChannelMediaType::parse("image/png").expect("type"),
                byte_length_hint: png.len() as u64,
            },
        );
        let err = on_missing
            .import(&missing)
            .expect_err("missing provider object must refuse");
        assert_eq!(err.code, codes::ASSET_IMPORT_FAILED);
    }

    #[test]
    fn unbound_inbound_seam_fails_closed_with_an_asset_code() {
        let mut seam = ChannelAttachmentImport::unbound();
        let request = AttachmentImportRequest::new(
            "account-a",
            "evt-x",
            &dolly_channel::attachment::InboundAttachment {
                ordinal: 0,
                provider_key: "k".to_string(),
                media_kind: ChannelMediaKind::Image,
                declared_media_type: ChannelMediaType::parse("image/png").expect("type"),
                byte_length_hint: 4,
            },
        );
        let err = seam.import(&request).expect_err("unbound refuses");
        assert_eq!(err.code, codes::ASSET_IMPORT_FAILED);
        assert_eq!(err.outcome, ChannelOutcome::NotApplied);
        let err = seam.status(&request).expect_err("unbound refuses status");
        assert_eq!(err.code, codes::ASSET_IMPORT_FAILED);
    }

    // -------------------------------------------------------------------
    // Registration ownership: shared, bounded, unregister/close, shutdown.
    // -------------------------------------------------------------------

    use dolly_core_reducer::TransitionOutcome;

    fn grid_config(now: &str) -> dolly_core_reducer::EnvironmentInput {
        dolly_core_reducer::EnvironmentInput {
            now: now.into(),
            ..Default::default()
        }
    }

    fn life_descriptor(module_id: &str) -> serde_json::Value {
        serde_json::json!({
            "schema": "dolly.module-descriptor/v1",
            "module_id": module_id,
            "descriptor_revision": 1,
            "display_name": module_id,
            "accepts": {"summary":"input","part_kinds":["text","asset"],"action_names":[]},
            "emits": {"summary":"output","part_kinds":["text","asset"],"action_names":["org.dolly.channel.send"]},
            "actions": [{"name":"org.dolly.channel.send","summary":"send"}],
            "activation_replay_contract": {"mode":"fenced_replay","evidence":"pure_compute","ledger":null},
            "trust": "trusted",
            "metadata": {}
        })
    }

    fn life_graph(module_id: &str) -> serde_json::Value {
        let descriptor = life_descriptor(module_id);
        let (_, digest) =
            dolly_canonical_json::canonicalize(&descriptor).expect("descriptor canonical");
        let mut descriptors = serde_json::Map::new();
        descriptors.insert(
            module_id.into(),
            serde_json::json!({
                "module_id": module_id,
                "descriptor_revision": 1,
                "source_descriptor_digest": digest.to_canonical_string(),
                "owner_extension_id": "org.dolly.channel",
                "value": descriptor
            }),
        );
        serde_json::json!({
            "receiving_module": module_id,
            "input_pages": {module_id: ["page-in"]},
            "output_pages": {module_id: ["page-web-primary"]},
            "subscriptions": {},
            "descriptors": descriptors,
            "authorized_metadata_namespaces": ["org.dolly.channel"],
            "authorized_action_names": ["org.dolly.channel.send"]
        })
    }

    /// A sealed authority/grant carrying the exact asset host methods —
    /// the minimal durable state `asset_route_register` binds to.
    fn life_authority_grant(
        mark: &str,
    ) -> (
        rusqlite::Connection,
        dolly_storage::HostConnectionAuthority,
        dolly_storage::HostCapabilityGrant,
    ) {
        use dolly_core_reducer::{CoreCommand, InstallConfigCommand, InstallGraphCommand};
        let now = "2026-08-28T00:00:00.000000Z";
        let mut runtime = rusqlite::Connection::open_in_memory().unwrap();
        let authority = {
            let mut store = dolly_storage::SqliteCoreStore::new(&mut runtime).expect("core schema");
            let config = serde_json::json!({
                "execution_timeout_ms": 120000,
                "lease_grace_ms": 30000,
                "fencing_grace_ms": 5000,
                "extension_connection_id": format!("{mark}-connection"),
                "worker_epoch": "0198ab31-6c44-7e8a-b2bb-000000000110",
                "worker_epoch_fence": 17
            });
            let (_, cdigest) =
                dolly_canonical_json::canonicalize(&config).expect("config canonical");
            let transition = store
                .transact(
                    &CoreCommand::InstallConfig(InstallConfigCommand {
                        command_id: format!("{mark}-config"),
                        revision: 1,
                        digest: cdigest.to_canonical_string(),
                        effective_config: config,
                    }),
                    &grid_config(now),
                )
                .expect("config install");
            assert_eq!(transition.outcome, TransitionOutcome::Committed);
            store
                .bootstrap_host_connection()
                .expect("host connection bootstrap");
            let graph = life_graph("web-channel");
            let (_, gdigest) = dolly_canonical_json::canonicalize(&graph).expect("graph canonical");
            let transition = store
                .transact(
                    &CoreCommand::InstallGraph(InstallGraphCommand {
                        command_id: format!("{mark}-graph"),
                        revision: 1,
                        digest: gdigest.to_canonical_string(),
                        graph,
                    }),
                    &grid_config(now),
                )
                .expect("graph install");
            assert_eq!(transition.outcome, TransitionOutcome::Committed);
            let authority = store.authenticated_host_connection().expect("authority");
            let descriptor = life_descriptor("web-channel");
            let (_, ddigest) =
                dolly_canonical_json::canonicalize(&descriptor).expect("descriptor canonical");
            store
                .install_host_capability_grant(
                    &authority,
                    "org.dolly.channel",
                    "web-channel",
                    1,
                    1,
                    &ddigest.to_canonical_string(),
                    1,
                    &cdigest.to_canonical_string(),
                    1,
                    &gdigest.to_canonical_string(),
                    &["host.asset.import", "host.asset.status"],
                )
                .expect("grant");
            authority
        };
        let grant = {
            let store = dolly_storage::SqliteCoreStore::new(&mut runtime).expect("core schema");
            store
                .current_host_capability_grant(&authority, "org.dolly.channel", "web-channel")
                .expect("current grant read")
                .expect("grant present")
        };
        (runtime, authority, grant)
    }

    fn life_config(root: &std::path::Path) -> ResolvedAssetConfig {
        let mut config = ResolvedAssetConfig::with_local_root(root.to_path_buf());
        config.max_decoded_bytes = 64 * 1024;
        config.max_inline_base64_chars = 128 * 1024;
        config.max_image_pixels = 1_000_000;
        config
    }

    #[test]
    fn asset_owner_serializes_concurrent_routes_and_closes_without_overlap() {
        let baseline = asset_route_registry_len();
        let (mut db, authority, grant) = life_authority_grant("acc-life");
        let dir = tempfile::tempdir().expect("tempdir");
        let other_dir = tempfile::tempdir().expect("other tempdir");
        let config = life_config(dir.path());
        let png = png_bytes(4, 2);
        let owners_before = asset_route_owners_created();

        let first = super::asset_route_register(&authority, &grant, 1, config.clone())
            .expect("first registration");
        let second = super::asset_route_register(&authority, &grant, 1, config.clone())
            .expect("second registration");
        let opened = super::asset_route_open(&authority, &grant, 1, &config).expect("shared open");
        assert!(first.same_registration(&second));
        assert!(first.same_registration(&opened));
        assert_eq!(asset_route_registry_len(), baseline + 1);
        assert_eq!(asset_route_owners_created(), owners_before + 1);

        // A typed serde round trip has the same JCS bytes and digest, so it
        // shares the existing owner rather than creating another service.
        let semantically_identical: ResolvedAssetConfig = serde_json::from_slice(
            &serde_json::to_vec(&config).expect("serialize resolved config"),
        )
        .expect("deserialize resolved config");
        let same_config =
            super::asset_route_register(&authority, &grant, 1, semantically_identical.clone())
                .expect("semantically identical canonical config shares");
        let same_config_open =
            super::asset_route_open(&authority, &grant, 1, &semantically_identical)
                .expect("same canonical config opens");
        assert!(first.same_registration(&same_config));
        assert!(first.same_registration(&same_config_open));
        assert_eq!(first.config_identity(), same_config.config_identity());
        first
            .config_identity()
            .digest
            .verify_bytes(first.config_identity().canonical_jcs.as_bytes())
            .expect("stored digest verifies the stored canonical bytes");
        assert_ne!(
            first.config_identity(),
            &asset_route_config_identity(2, &config).expect("different revision identity"),
            "the canonical digest also binds the configuration revision"
        );
        assert_eq!(
            asset_route_owners_created(),
            owners_before + 1,
            "identical configuration cannot create a second owner"
        );

        // Same root, key, and revision are insufficient: both a top-level
        // bound and an independent nested retry field change the full digest.
        let mut stale_restart_config = config.clone();
        stale_restart_config.max_decoded_bytes += 1;
        let stale_identity =
            asset_route_config_identity(1, &stale_restart_config).expect("stale identity");
        assert_ne!(first.config_identity(), &stale_identity);
        assert!(matches!(
            super::asset_route_register(&authority, &grant, 1, stale_restart_config.clone()),
            Err(HostRouteError::CapabilityDenied { .. })
        ));
        assert!(matches!(
            super::asset_route_open(&authority, &grant, 1, &stale_restart_config),
            Err(HostRouteError::CapabilityDenied { .. })
        ));

        let mut nested_field_mismatch = config.clone();
        nested_field_mismatch.replica_retry.retry_base_ms += 1;
        let nested_identity =
            asset_route_config_identity(1, &nested_field_mismatch).expect("nested identity");
        assert_ne!(first.config_identity(), &nested_identity);
        assert!(matches!(
            super::asset_route_register(&authority, &grant, 1, nested_field_mismatch.clone()),
            Err(HostRouteError::CapabilityDenied { .. })
        ));
        assert!(matches!(
            super::asset_route_open(&authority, &grant, 1, &nested_field_mismatch),
            Err(HostRouteError::CapabilityDenied { .. })
        ));
        assert_eq!(asset_route_registry_len(), baseline + 1);
        assert_eq!(
            asset_route_owners_created(),
            owners_before + 1,
            "configuration mismatch must be refused before owner creation"
        );

        let asset_id = import_available(&first, "0198ab31-6c44-7e8a-b2bb-000000000120", &png);
        let prepare_premise = AssetPremise {
            ordinal: 0,
            asset_id: ChannelAssetId::parse(&asset_id).expect("canonical id"),
            media_type: ChannelMediaType::parse("image/png").expect("canonical type"),
            view: None,
        };
        let mut prepare =
            ChannelAssetSeam::from_registration(&first).expect("prepare handle opens");
        let mut import = ChannelAttachmentImport::from_test_owner(
            &first,
            "test-account",
            Box::new(FakeProvider::serving(png.clone())),
        )
        .expect("import handle opens");
        let import_request = AttachmentImportRequest::new(
            "test-account",
            "evt-concurrent",
            &dolly_channel::attachment::InboundAttachment {
                ordinal: 0,
                provider_key: "provider-concurrent".to_string(),
                media_kind: ChannelMediaKind::Image,
                declared_media_type: ChannelMediaType::parse("image/png").expect("type"),
                byte_length_hint: png.len() as u64,
            },
        );
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let prepare_barrier = Arc::clone(&barrier);
        let prepare_thread = std::thread::spawn(move || {
            prepare_barrier.wait();
            prepare
                .prepare_assets(&[prepare_premise])
                .expect("concurrent prepare")
        });
        let import_barrier = Arc::clone(&barrier);
        let import_thread = std::thread::spawn(move || {
            import_barrier.wait();
            import.import(&import_request).expect("concurrent import")
        });
        barrier.wait();
        assert_eq!(prepare_thread.join().expect("prepare thread").len(), 1);
        assert!(matches!(
            import_thread.join().expect("import thread"),
            AttachmentImportStatus::Available(_)
        ));
        assert_eq!(
            first
                .registration
                .owner
                .metrics
                .maximum_active_operations
                .load(Ordering::SeqCst),
            1,
            "one owner serializes every AssetService operation"
        );
        assert_eq!(
            first
                .registration
                .owner
                .metrics
                .queued_requests
                .load(Ordering::SeqCst),
            0
        );

        let root_mismatch =
            super::asset_route_register(&authority, &grant, 1, life_config(other_dir.path()));
        assert!(matches!(
            root_mismatch,
            Err(HostRouteError::CapabilityDenied { .. })
        ));
        assert!(matches!(
            super::asset_route_open(&authority, &grant, 99, &config),
            Err(HostRouteError::CapabilityDenied { .. })
        ));

        let generation_two = {
            let mut store = dolly_storage::SqliteCoreStore::new(&mut db).expect("core schema");
            store
                .install_host_capability_grant(
                    &authority,
                    grant.extension_id(),
                    grant.module_id(),
                    2,
                    grant.descriptor_revision(),
                    grant.descriptor_digest(),
                    grant.manifest_revision(),
                    grant.manifest_digest(),
                    grant.graph_revision(),
                    grant.graph_digest(),
                    &["host.asset.import", "host.asset.status"],
                )
                .expect("replace grant generation");
            store
                .current_host_capability_grant(&authority, grant.extension_id(), grant.module_id())
                .expect("read generation")
                .expect("generation present")
        };
        assert!(matches!(
            super::asset_route_register(&authority, &generation_two, 1, config.clone()),
            Err(HostRouteError::CapabilityDenied { .. })
        ));
        assert!(matches!(
            super::asset_route_open(&authority, &generation_two, 1, &config),
            Err(HostRouteError::CapabilityDenied { .. })
        ));

        let mut old_seam =
            ChannelAssetSeam::from_registration(&first).expect("old handle before close");
        assert!(super::asset_route_unregister(&authority, &grant, 1).expect("unregister"));
        assert!(!super::asset_route_unregister(&authority, &grant, 1).expect("idempotent close"));
        assert!(ChannelAssetSeam::from_registration(&first).is_err());
        let closed_error = old_seam
            .prepare_assets(&[AssetPremise {
                ordinal: 0,
                asset_id: ChannelAssetId::parse(&asset_id).expect("canonical id"),
                media_type: ChannelMediaType::parse("image/png").expect("canonical type"),
                view: None,
            }])
            .expect_err("existing handle observes close");
        assert_eq!(closed_error.code, codes::ASSET_IMPORT_FAILED);
        assert!(matches!(
            super::asset_route_register(&authority, &grant, 1, config.clone()),
            Err(HostRouteError::Rejected { ref code, .. }) if code == "ASSET_OWNER_CLOSING"
        ));
        assert_eq!(
            asset_route_registry_len(),
            baseline + 1,
            "closing registration remains while handles are live"
        );

        let old_registration = Arc::clone(&first.registration);
        drop(old_seam);
        drop(same_config_open);
        drop(same_config);
        drop(opened);
        drop(second);
        drop(first);
        assert_eq!(old_registration.state(), AssetOwnerState::Closed);
        assert!(
            !old_registration
                .owner
                .metrics
                .thread_live
                .load(Ordering::SeqCst)
        );
        assert_eq!(
            old_registration
                .owner
                .metrics
                .queued_requests
                .load(Ordering::SeqCst),
            0
        );
        assert!(old_registration.owner.join.lock().is_none());
        assert_eq!(asset_route_registry_len(), baseline);

        let replacement =
            super::asset_route_register(&authority, &generation_two, 1, config.clone())
                .expect("new generation registers after joined close");
        let replacement_again =
            super::asset_route_register(&authority, &generation_two, 1, config.clone())
                .expect("new generation shares once");
        assert!(replacement.same_registration(&replacement_again));
        assert!(super::asset_route_unregister(&authority, &generation_two, 1).unwrap());
        drop(replacement_again);
        drop(replacement);
        assert_eq!(asset_route_registry_len(), baseline);

        for cycle in 0..5 {
            let registered =
                super::asset_route_register(&authority, &generation_two, 1, config.clone())
                    .expect("cycle register");
            let opened = super::asset_route_open(&authority, &generation_two, 1, &config)
                .expect("cycle open");
            assert!(registered.same_registration(&opened));
            assert!(super::asset_route_unregister(&authority, &generation_two, 1).unwrap());
            assert!(
                super::asset_route_register(&authority, &generation_two, 1, config.clone())
                    .is_err()
            );
            drop(opened);
            drop(registered);
            assert_eq!(
                asset_route_registry_len(),
                baseline,
                "cycle {cycle} returns registry to baseline after join"
            );
        }

        let shutdown_handle = super::asset_route_register(&authority, &generation_two, 1, config)
            .expect("shutdown registration");
        let shutdown_registration = Arc::clone(&shutdown_handle.registration);
        super::asset_route_shutdown().expect("bounded shutdown joins owner");
        assert_eq!(shutdown_registration.state(), AssetOwnerState::Closed);
        assert!(
            !shutdown_registration
                .owner
                .metrics
                .thread_live
                .load(Ordering::SeqCst)
        );
        assert_eq!(
            shutdown_registration
                .owner
                .metrics
                .queued_requests
                .load(Ordering::SeqCst),
            0
        );
        assert!(shutdown_registration.owner.join.lock().is_none());
        assert_eq!(
            asset_route_registry_len(),
            baseline + 1,
            "closed entry remains until the live handle drops"
        );
        assert!(
            super::asset_route_open(&authority, &generation_two, 1, &life_config(dir.path()))
                .is_err()
        );
        drop(shutdown_handle);
        assert_eq!(asset_route_registry_len(), baseline);
    }

    // -------------------------------------------------------------------
    // Ownership/copy: the prepared byte buffer is MOVED, never cloned.
    // -------------------------------------------------------------------

    #[test]
    fn convert_prepared_media_moves_the_owned_byte_buffer() {
        // A large bounded payload: the same allocation must be moved into the
        // Channel AssetPayload (a clone would allocate a second buffer with a
        // different address).
        let large = vec![0xABu8; 48 * 1024];
        let asset_ref_parts = {
            let asset_id = dolly_asset::identity::AssetId::from_digest([0u8; 32]);
            dolly_asset::identity::AssetRef {
                asset_id,
                media_type: dolly_asset::identity::MediaType::parse("image/png").expect("type"),
                byte_length: large.len() as u64,
                orientation: None,
                encoded_width: None,
                encoded_height: None,
                display_width: None,
                display_height: None,
            }
        };
        asset_ref_parts.validate().expect("canonical ref");
        let prepared = PreparedMedia {
            asset_ref: asset_ref_parts,
            media_kind: MediaKind::Image,
            generation: 7,
            digest: dolly_asset::identity::ContentHash {
                algorithm: "blake3-256",
                digest: [0u8; 32],
            },
            lease_id: "lease-moved".to_string(),
            lease_expires_at_ms: 1_800_000_000_000 + 30_000,
            bytes: large,
        };
        let original_ptr = prepared.bytes.as_ptr();
        let payload = convert_prepared_media(0, prepared).expect("conversion consumes by value");
        assert_eq!(
            payload.bytes.len(),
            48 * 1024,
            "exact large bounded payload"
        );
        assert_eq!(payload.bytes[0], 0xAB, "exact byte content");
        assert_eq!(
            payload.bytes.as_ptr(),
            original_ptr,
            "the owned byte buffer is moved into the Channel payload, never cloned"
        );
        // Every typed field survives the move losslessly.
        assert_eq!(payload.generation, 7);
        assert_eq!(payload.lease_id, "lease-moved");
        assert_eq!(payload.media_kind, ChannelMediaKind::Image);
        assert_eq!(payload.asset_ref.byte_length, 48 * 1024);
        assert_eq!(payload.asset_ref.media_type.as_str(), "image/png");
    }
}
