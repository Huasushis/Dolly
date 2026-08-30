//! The `AssetService` façade: the minimal stable Core-owned interface for
//! consumers such as WP-013B.
//!
//! Capabilities are minted only by the service (the Host boundary); every
//! mutation and read is bound to one security domain carried by the
//! capability, so a caller can never assert another domain. Imports record
//! the caller's module and instance and the service checks the capability's
//! module against the request.

use crate::clock::{Clock, SystemClock};
use crate::config::ResolvedAssetConfig;
use crate::content::{ObjectReader, delete_staging};
use crate::error::{AssetError, AssetErrorCode, ErrorPhase};
use crate::gc::{self, GcReport};
use crate::pipeline::{ImportPipeline, RecoveryReport, validate_request};
use crate::prepare::{
    MediaPrepareRequest, PreparedMedia, PrepareFailpoint, media_kind_of_type, read_and_verify,
    validate_prepare_authority,
};
use crate::record::{
    AssetLease, AssetPin, AssetReference, ImportRecord, ImportRequest, StatusResult,
};
use crate::remote::{DeniedFetcher, RemoteFetcher, SshDenyPolicy};
use crate::replica::{DisabledReplica, ReplicaDriver};
use crate::retention;
use crate::source::{FileCapability, FileCapabilityRegistry, StreamCapabilityRegistry};
use crate::store::AssetStore;
use dolly_core_domain::LeaseToken;
use std::collections::HashMap;
use std::io::{self, Cursor, Read};
use std::path::{Path, PathBuf};

/// An opaque security-domain capability minted by the service for the Host.
/// Fields are private: a caller cannot forge or widen its domain, module, or
/// instance, and cannot replay a capability minted by another (stale) Host
/// lifecycle because the epoch binds it to the issuing service instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetCapability {
    domain: String,
    module_id: String,
    instance_id: String,
    /// The issuing service's Host-lifecycle epoch. Capabilities from another
    /// service instance (or a pre-restart instance) fail closed.
    epoch: u64,
}

impl AssetCapability {
    pub fn domain(&self) -> &str {
        &self.domain
    }
    pub fn module_id(&self) -> &str {
        &self.module_id
    }
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }
}

/// Host-issued file capability table (in-lane; production Host wires its own
/// registry with the same contract).
#[derive(Default)]
pub struct FileCapabilityTable {
    entries: HashMap<String, FileCapability>,
}

impl FileCapabilityRegistry for FileCapabilityTable {
    fn resolve(&self, token: &LeaseToken) -> Option<FileCapability> {
        self.entries.get(&token.expose_base64url()).cloned()
    }
}

impl FileCapabilityTable {
    pub fn insert(&mut self, token: LeaseToken, capability: FileCapability) {
        self.entries
            .insert(token.expose_base64url(), capability);
    }
}

/// Host-issued single-use stream capability table (in-lane).
#[derive(Default)]
pub struct StreamCapabilityTable {
    entries: HashMap<String, Vec<u8>>,
}

impl StreamCapabilityRegistry for StreamCapabilityTable {
    fn take(&mut self, token: &LeaseToken) -> Option<Box<dyn Read + Send>> {
        self.entries
            .remove(&token.expose_base64url())
            .map(|bytes| Box::new(Cursor::new(bytes)) as Box<dyn Read + Send>)
    }
}

impl StreamCapabilityTable {
    pub fn insert(&mut self, token: LeaseToken, bytes: Vec<u8>) {
        self.entries.insert(token.expose_base64url(), bytes);
    }
}

/// A bounded read grant over one available asset, domain-checked at grant
/// time. Never exposes a path; reads stop at the recorded byte length.
pub struct ReadGrant {
    byte_length: u64,
    reader: ObjectReader,
}

impl ReadGrant {
    fn open(content_root: &Path, asset_id: &str, byte_length: u64) -> io::Result<Self> {
        let reader = ObjectReader::open(content_root, asset_id, byte_length)?;
        Ok(Self {
            byte_length,
            reader,
        })
    }

    pub fn byte_length(&self) -> u64 {
        self.byte_length
    }

    /// Read at most `buf.len()` bytes, capped by the recorded length.
    pub fn read_bounded(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.reader.read_bounded(buf)
    }
}

/// The Core-owned binary Asset service.
pub struct AssetService {
    store: AssetStore,
    config: ResolvedAssetConfig,
    clock: Box<dyn Clock>,
    file_caps: FileCapabilityTable,
    stream_caps: StreamCapabilityTable,
    fetcher: Box<dyn RemoteFetcher>,
    replica: Box<dyn ReplicaDriver>,
    policy: SshDenyPolicy,
    /// This service instance's Host-lifecycle epoch. Every capability is
    /// bound to it; a capability from another (stale) service instance is
    /// refused before any store read or mutation.
    epoch: u64,
    /// Deterministic race control for tests; never armed in production.
    prepare_failpoint: Option<PrepareFailpoint>,
}

impl AssetService {
    /// Open (create) the asset service over one local content root. The
    /// durable store lives at `<local_root>/asset-store.sqlite`.
    pub fn open(config: ResolvedAssetConfig) -> Result<Self, AssetError> {
        config.validate().map_err(|message| {
            AssetError::new(
                AssetErrorCode::InvalidRequest,
                ErrorPhase::Validate,
                format!("invalid asset configuration: {message}"),
            )
        })?;
        let store_path = config.local_root.join("asset-store.sqlite");
        let store = AssetStore::open(&store_path).map_err(|e| {
            AssetError::new(
                AssetErrorCode::StorageFull,
                ErrorPhase::Accept,
                format!("cannot open the asset store: {e}"),
            )
        })?;
        let prefix = config
            .replica
            .prefix
            .clone()
            .unwrap_or_else(|| "dolly-assets".to_string());
        let epoch = mint_lifecycle_epoch()?;
        Ok(Self {
            store,
            clock: Box::new(SystemClock),
            prepare_failpoint: None,
            file_caps: FileCapabilityTable::default(),
            stream_caps: StreamCapabilityTable::default(),
            fetcher: Box::new(DeniedFetcher),
            replica: Box::new(DisabledReplica::new(prefix)),
            policy: SshDenyPolicy::new(&[]),
            config,
            epoch,
        })
    }

    /// Make the service deterministic for tests (fixed clock and, optionally,
    /// an in-memory replicas driver).
    pub fn open_with<C, F, R>(
        config: ResolvedAssetConfig,
        clock: C,
        fetcher: F,
        replica: R,
    ) -> Result<Self, AssetError>
    where
        C: Clock + 'static,
        F: RemoteFetcher + 'static,
        R: ReplicaDriver + 'static,
    {
        config.validate().map_err(|message| {
            AssetError::new(
                AssetErrorCode::InvalidRequest,
                ErrorPhase::Validate,
                format!("invalid asset configuration: {message}"),
            )
        })?;
        let store_path = config.local_root.join("asset-store.sqlite");
        let store = AssetStore::open(&store_path).map_err(|e| {
            AssetError::new(
                AssetErrorCode::StorageFull,
                ErrorPhase::Accept,
                format!("cannot open the asset store: {e}"),
            )
        })?;
        let epoch = mint_lifecycle_epoch()?;
        Ok(Self {
            store,
            clock: Box::new(clock),
            prepare_failpoint: None,
            file_caps: FileCapabilityTable::default(),
            stream_caps: StreamCapabilityTable::default(),
            fetcher: Box::new(fetcher),
            replica: Box::new(replica),
            policy: SshDenyPolicy::new(&[]),
            config,
            epoch,
        })
    }

    /// Mint a capability for one security domain, instance, and module (Host
    /// boundary).
    pub fn issue_capability(
        &self,
        domain: impl Into<String>,
        instance_id: impl Into<String>,
        module_id: impl Into<String>,
    ) -> AssetCapability {
        AssetCapability {
            domain: domain.into(),
            instance_id: instance_id.into(),
            module_id: module_id.into(),
            epoch: self.epoch,
        }
    }

    /// Fail closed when the capability was minted by another service
    /// instance: a stale Host lifecycle must not reach the store.
    fn check_live(&self, capability: &AssetCapability) -> Result<(), AssetError> {
        if capability.epoch != self.epoch {
            return Err(AssetError::new(
                AssetErrorCode::Unauthorized,
                ErrorPhase::Accept,
                "capability belongs to a different Host lifecycle".to_string(),
            ));
        }
        Ok(())
    }

    /// Arm (or disarm) the deterministic preparation failpoint. Production
    /// never arms it; tests use it to revoke the lease or alter durable
    /// state in the exact window between the blocking read and the
    /// post-read revalidation.
    pub fn arm_prepare_failpoint(&mut self, failpoint: Option<PrepareFailpoint>) {
        self.prepare_failpoint = failpoint;
    }

    /// Register a Host-issued file capability inside an allowed root.
    pub fn register_file_capability(
        &mut self,
        allowed_root: PathBuf,
        real_path: PathBuf,
        max_bytes: Option<u64>,
    ) -> Result<LeaseToken, AssetError> {
        if !real_path.starts_with(&allowed_root) {
            return Err(AssetError::new(
                AssetErrorCode::SourceDenied,
                ErrorPhase::Acquire,
                "file capability path must be inside its allowed root".to_string(),
            ));
        }
        let token = mint_capability_token();
        self.file_caps.insert(
            token.clone(),
            FileCapability {
                real_path,
                allowed_root,
                max_bytes,
            },
        );
        Ok(token)
    }

    /// Register a single-use stream capability with known bytes.
    pub fn register_stream(&mut self, bytes: Vec<u8>) -> LeaseToken {
        let token = mint_capability_token();
        self.stream_caps.insert(token.clone(), bytes);
        token
    }

    fn pipeline(&mut self) -> ImportPipeline<'_> {
        ImportPipeline {
            store: &mut self.store,
            config: &self.config,
            content_root: &self.config.local_root,
            clock: self.clock.as_mut(),
            file_caps: &self.file_caps,
            stream_caps: &mut self.stream_caps,
            fetcher: self.fetcher.as_mut(),
            policy: &self.policy,
            replica: self.replica.as_mut(),
        }
    }

    fn check_request_module(&self, capability: &AssetCapability, request: &ImportRequest) -> Result<(), AssetError> {
        if capability.module_id != request.module_id {
            return Err(AssetError::new(
                AssetErrorCode::Unauthorized,
                ErrorPhase::Validate,
                "capability module does not match the request module".to_string(),
            )
            .with_import_id(&request.import_id));
        }
        if capability.instance_id != request.instance_id {
            return Err(AssetError::new(
                AssetErrorCode::Unauthorized,
                ErrorPhase::Validate,
                "capability instance does not match the request instance".to_string(),
            )
            .with_import_id(&request.import_id));
        }
        Ok(())
    }

    /// Import one asset (or replay an identical import) to a terminal state.
    pub fn import(
        &mut self,
        capability: &AssetCapability,
        request: &ImportRequest,
    ) -> Result<StatusResult, AssetError> {
        self.check_live(capability)?;
        self.check_request_module(capability, request)?;
        let result = self.pipeline().import(&capability.domain, request);
        self.reconcile_rejected_canceled(&capability.domain, request, &result);
        result
    }

    /// Host-run recovery after a restart: resolve every non-terminal import.
    pub fn recover(&mut self) -> Result<RecoveryReport, AssetError> {
        self.pipeline().recover()
    }

    /// Host-run deterministic GC sweep.
    pub fn run_gc(&mut self) -> Result<GcReport, AssetError> {
        let grace = {
            let config = &self.config;
            config.gc_grace_ms
        };
        gc::run_gc_with_grace(
            &mut self.store,
            &self.config.local_root,
            self.clock.as_mut(),
            grace,
            self.replica.as_mut(),
            true,
        )
    }

    /// Read-only status; bound to the capability's exact instance, module,
    /// and security domain. Unknown and cross-owner `ImportId`s both resolve
    /// to the closed `absent` outcome (spec §7: they are indistinguishable),
    /// which never carries an `AssetRef` and never mirrors a lifecycle state.
    pub fn status(
        &mut self,
        capability: &AssetCapability,
        import_id: &str,
    ) -> Result<StatusResult, AssetError> {
        self.check_live(capability)?;
        match self.load_owned_import(capability, import_id)? {
            Some(record) => Ok(StatusResult::from_record(&record)),
            None => Ok(StatusResult::absent(import_id)),
        }
    }

    /// Load one import record after binding the capability's exact instance,
    /// module, and security domain. Unknown and cross-owner lookups both
    /// yield `None`, so a caller cannot distinguish them and no record body
    /// is returned to the wrong owner.
    fn load_owned_import(
        &mut self,
        capability: &AssetCapability,
        import_id: &str,
    ) -> Result<Option<ImportRecord>, AssetError> {
        let tx = self.store.transaction().map_err(store_error_public)?;
        let record = tx.load_import(import_id).map_err(store_error_public)?;
        tx.commit().map_err(store_error_public)?;
        let Some(record) = record else {
            return Ok(None);
        };
        if record.security_domain != capability.domain
            || record.module_id != capability.module_id
            || record.instance_id != capability.instance_id
        {
            return Ok(None);
        }
        Ok(Some(record))
    }

    /// Cancel a non-terminal import owned by the capability's exact
    /// instance, module, and security domain. Cross-owner and unknown
    /// `ImportId`s are refused before any mutation.
    pub fn cancel(
        &mut self,
        capability: &AssetCapability,
        import_id: &str,
    ) -> Result<StatusResult, AssetError> {
        self.check_live(capability)?;
        if self.load_owned_import(capability, import_id)?.is_none() {
            return Err(AssetError::new(
                AssetErrorCode::NotFound,
                ErrorPhase::Accept,
                "no such import".to_string(),
            )
            .with_import_id(import_id));
        }
        self.pipeline().cancel(import_id)
    }

    /// A bounded, domain-checked read grant over one available asset.
    pub fn read(
        &mut self,
        capability: &AssetCapability,
        asset_id: &str,
    ) -> Result<ReadGrant, AssetError> {
        let tx = self.store.transaction().map_err(store_error_public)?;
        let asset = tx
            .load_live_asset(asset_id, &capability.domain)
            .map_err(store_error_public)?;
        tx.commit().map_err(store_error_public)?;
        let Some(asset) = asset else {
            return Err(AssetError::new(
                AssetErrorCode::NotFound,
                ErrorPhase::Acquire,
                "asset is not available in this security domain".to_string(),
            ));
        };
        if asset.lifecycle != crate::record::Lifecycle::Live
            || asset.local_state != crate::record::LocalState::Present
        {
            return Err(AssetError::new(
                AssetErrorCode::NotFound,
                ErrorPhase::Acquire,
                "asset bytes are not present".to_string(),
            ));
        }
        ReadGrant::open(&self.config.local_root, asset_id, asset.byte_length).map_err(|e| {
            AssetError::new(
                AssetErrorCode::Internal,
                ErrorPhase::Acquire,
                format!("cannot open asset bytes: {e}"),
            )
        })
    }

    /// Create a finite lease owned by one consumer (atomic with the
    /// tombstone check; never converted to a pin).
    pub fn lease(
        &mut self,
        capability: &AssetCapability,
        asset_id: &str,
        owner: &str,
        purpose: &str,
        ttl_ms: u64,
    ) -> Result<AssetLease, AssetError> {
        retention::create_lease(
            &mut self.store,
            &self.config,
            self.clock.as_mut(),
            asset_id,
            &capability.domain,
            owner,
            purpose,
            ttl_ms,
        )
    }

    pub fn release_lease(&mut self, lease_id: &str) -> Result<bool, AssetError> {
        retention::release_lease(&mut self.store, lease_id)
    }

    /// Create a durable pin. Expiry-less pins require `privileged`.
    pub fn pin(
        &mut self,
        capability: &AssetCapability,
        asset_id: &str,
        owner: &str,
        reason: &str,
        expiry_ms: Option<u64>,
        privileged: bool,
    ) -> Result<AssetPin, AssetError> {
        retention::create_pin(
            &mut self.store,
            &self.config,
            self.clock.as_mut(),
            asset_id,
            &capability.domain,
            owner,
            reason,
            expiry_ms,
            privileged,
        )
    }

    pub fn remove_pin(&mut self, pin_id: &str) -> Result<bool, AssetError> {
        retention::remove_pin(&mut self.store, pin_id)
    }

    /// Create a durable reference owned by a committed Block, Page delivery,
    /// Memory record, or derived asset.
    pub fn create_reference(
        &mut self,
        capability: &AssetCapability,
        asset_id: &str,
        owner: &str,
        ref_key: &str,
    ) -> Result<AssetReference, AssetError> {
        retention::create_reference(
            &mut self.store,
            self.clock.as_mut(),
            asset_id,
            &capability.domain,
            owner,
            ref_key,
        )
    }

    pub fn remove_reference(
        &mut self,
        capability: &AssetCapability,
        asset_id: &str,
        generation: u64,
        ref_key: &str,
    ) -> Result<bool, AssetError> {
        let _ = capability;
        retention::remove_reference(&mut self.store, asset_id, &capability.domain, generation, ref_key)
    }

    /// Reject prompt: confirm a request would survive validation (used by
    /// tests and Host admission checks without touching the store).
    pub fn preflight(&self, request: &ImportRequest) -> Result<(), AssetError> {
        validate_request(&self.config, request)
    }

    /// Number of durable import records (Host diagnostics and tests).
    pub fn store_import_count(&self) -> usize {
        self.store.load_import_count().unwrap_or(0) as usize
    }

    /// The opened configuration (Host wiring and tests).
    pub fn config_ro(&self) -> &ResolvedAssetConfig {
        &self.config
    }

    /// A store transaction for Host wiring and seed/recovery tests. This is
    /// the same authority the import pipeline uses.
    pub fn store_transaction(
        &mut self,
    ) -> Result<crate::store::StoreTransaction<'_>, AssetError> {
        self.store.transaction().map_err(store_error_public)
    }

    /// Iterator over deletion failures for operator enumeration.
    pub fn deletion_failures(&mut self) -> Result<Vec<crate::record::AssetTombstone>, AssetError> {
        gc::enumerate_deletion_failures(&mut self.store)
    }

    /// The caller supplies only the committed `AssetId`, kind/type claims,
    /// and the exact lease it holds. The service resolves the durable,
    /// authoritative row itself: only an asset whose lifecycle row is live
    /// and present in this security domain at the current generation, whose
    /// content identity re-derives the committed `AssetId`, and whose lease
    /// is unexpired and bound to this capability's instance, domain, asset,
    /// and generation is accepted. The canonical `AssetRef` is minted by the
    /// service from the row (no caller metadata is echoed); bytes are read
    /// through the content-addressed `ObjectReader`, verified against the
    /// recorded digest, and the full authority is revalidated after the
    /// blocking read and immediately before the typed result is released.
    pub fn prepare_media(
        &mut self,
        capability: &AssetCapability,
        request: &MediaPrepareRequest,
    ) -> Result<PreparedMedia, AssetError> {
        self.check_live(capability)?;
        let asset_id = request.asset_id.as_str().to_string();

        // Phase 1: snapshot and validate the exact lease and durable
        // AVAILABLE authority in one transaction.
        let first = {
            let tx = self.store.transaction().map_err(store_error_public)?;
            let authority = validate_prepare_authority(
                &tx,
                capability,
                request,
                self.clock.now().millis,
            )?;
            tx.commit().map_err(store_error_public)?;
            authority
        };

        // Config authority at preparation time: a lowered decoded bound
        // fails closed here, exactly like any other admission.
        if first.asset.byte_length > self.config.max_decoded_bytes {
            return Err(AssetError::new(
                AssetErrorCode::SizeLimit,
                ErrorPhase::Acquire,
                format!(
                    "asset byte length {} exceeds the configured decoded bound {}",
                    first.asset.byte_length, self.config.max_decoded_bytes
                ),
            ));
        }

        // Phase 2: bounded content-addressed read with digest verification.
        // The read re-proves `AssetId = BLAKE3(content)` because phase 1
        // bound the committed `AssetId` to the row's recorded digest and the
        // returned bytes are verified against exactly that digest.
        let bytes = read_and_verify(
            &self.config.local_root,
            &asset_id,
            first.asset.byte_length,
            &first.asset.content_hash,
        )?;

        // Deterministic race control (tests only): run exactly between the
        // blocking read and the post-read revalidation.
        if let Some(failpoint) = &mut self.prepare_failpoint {
            (failpoint.after_read)(&mut self.store);
        }

        // Phase 3: revalidate the full authority after the blocking work
        // and immediately before releasing the bytes.
        let revalidated = {
            let tx = self.store.transaction().map_err(store_error_public)?;
            let authority = validate_prepare_authority(
                &tx,
                capability,
                request,
                self.clock.now().millis,
            )?;
            if authority.asset.content_hash != first.asset.content_hash
                || authority.asset.byte_length != first.asset.byte_length
            {
                tx.commit().map_err(store_error_public)?;
                return Err(AssetError::new(
                    AssetErrorCode::NotFound,
                    ErrorPhase::Acquire,
                    "asset state changed during preparation".to_string(),
                ));
            }
            tx.commit().map_err(store_error_public)?;
            authority
        };

        Ok(PreparedMedia {
            asset_ref: revalidated.canonical_ref,
            media_kind: media_kind_of_type(Some(&revalidated.detected_type)),
            generation: revalidated.asset.generation,
            digest: revalidated.asset.content_hash,
            lease_id: revalidated.lease.lease_id,
            lease_expires_at_ms: revalidated.lease.expires_at_ms,
            bytes,
        })
    }
    /// Reconciliation hook: a rejected/cancelled terminal import must keep
    /// its staging bytes deleted and must never expose partial authority.
    fn reconcile_rejected_canceled(
        &self,
        _domain: &str,
        request: &ImportRequest,
        result: &Result<StatusResult, AssetError>,
    ) {
        if let Ok(status) = result {
            if status.state == "rejected" || status.state == "cancelled" {
                delete_staging(&self.config.local_root, &format!("staging-{}", request.import_id));
            }
        }
    }
}

/// A fresh per-service Host-lifecycle epoch that every capability is bound
/// to. A capability minted by another service instance (or a pre-restart
/// instance) is refused before any store read or mutation.
///
/// Fails closed: if system entropy is unavailable the service refuses to
/// open rather than minting a zero or replayable epoch, which would let one
/// service's capability masquerade as another's.
fn mint_lifecycle_epoch() -> Result<u64, AssetError> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|_| {
        AssetError::new(
            AssetErrorCode::Internal,
            ErrorPhase::Accept,
            "cannot obtain system entropy for the Host lifecycle epoch; refusing to open",
        )
    })?;
    Ok(u64::from_le_bytes(bytes))
}

fn mint_capability_token() -> LeaseToken {
    let mut bytes = [0u8; 32];
    let _ = getrandom::fill(&mut bytes);
    let mut out = String::with_capacity(43);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in bytes.iter() {
        acc = (acc << 8) | byte as u32;
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            let idx = ((acc >> bits) & 0x3f) as usize;
            out.push(BASE64URL_ALPHABET[idx] as char);
        }
    }
    if bits > 0 {
        let idx = ((acc << (6 - bits)) & 0x3f) as usize;
        out.push(BASE64URL_ALPHABET[idx] as char);
    }
    debug_assert_eq!(out.len(), 43);
    // 32 bytes -> the final char always has its low two bits zero, which the
    // canonical LeaseToken parser requires.
    out.parse().expect("canonical capability token")
}

const BASE64URL_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn store_error_public(error: crate::store::StoreError) -> AssetError {
    AssetError::new(
        AssetErrorCode::Internal,
        ErrorPhase::Accept,
        format!("asset store failure: {error}"),
    )
}
