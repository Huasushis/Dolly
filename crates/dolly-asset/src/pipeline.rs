//! The import pipeline: the authoritative ACCEPTED..AVAILABLE state
//! machine with bounded acquisition, bounded media validation, durable
//! commit, crash recovery, and idempotent replay.
//!
//! Every durable forward transition is a compare-and-set on the current
//! state. Repeating one `ImportId` with byte-for-byte identical parameters
//! returns the existing state; reusing it with different parameters returns
//! `IMPORT_ID_CONFLICT` before any mutation. After a crash, `ACQUIRING` and
//! `VERIFYING` resume only from a complete verified staging object, and
//! `COMMITTING` is resolved by checking the content-addressed object and the
//! mapping (complete it if the object verifies, otherwise return to
//! `ACCEPTED`).

use crate::clock::Clock;
use crate::config::ResolvedAssetConfig;
use crate::content::{self, ObjectReader};
use crate::error::{AssetError, AssetErrorCode, ErrorPhase};
use crate::identity::{AssetId, ContentHash, MediaType};
use crate::media;
use crate::record::*;
use crate::remote::{RemoteFetcher, SshDenyPolicy};
use crate::replica::{ReplicaDriver, ReplicaObject, ReplicaVerifyResult};
use crate::source::{AcquireContext, FileCapabilityRegistry, StreamCapabilityRegistry};
use crate::store::{AssetStore, ImportPatch, StoreError};
use dolly_canonical_json::canonicalize;
use dolly_core_domain::{ModuleId, Timestamp, UuidV7};
use std::path::Path;

const SNIFF_HEAD_BYTES: usize = 16 * 1024;

/// Shared pipeline dependencies (borrowed from the service).
pub struct ImportPipeline<'a> {
    pub store: &'a mut AssetStore,
    pub config: &'a ResolvedAssetConfig,
    pub content_root: &'a Path,
    pub clock: &'a mut dyn Clock,
    pub file_caps: &'a dyn FileCapabilityRegistry,
    pub stream_caps: &'a mut dyn StreamCapabilityRegistry,
    pub fetcher: &'a mut dyn RemoteFetcher,
    pub policy: &'a SshDenyPolicy,
    pub replica: &'a mut dyn ReplicaDriver,
}

/// Result of one recovery pass.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecoveryReport {
    pub resumed_from_partial: u64,
    pub resolved_committing: u64,
    pub kept_verified: u64,
    pub pending_replicas: u64,
}

/// Validate the request shape, bounds, and capability coupling before any
/// durable write. All failures here leave no record: no partial authority.
pub fn validate_request(
    config: &ResolvedAssetConfig,
    request: &ImportRequest,
) -> Result<(), AssetError> {
    request
        .import_id
        .parse::<UuidV7>()
        .map_err(|_| {
            AssetError::new(
                AssetErrorCode::InvalidRequest,
                ErrorPhase::Validate,
                "import_id must be a valid UUIDv7".to_string(),
            )
        })?;
    request
        .instance_id
        .parse::<dolly_core_domain::InstanceId>()
        .map_err(|_| {
            AssetError::new(
                AssetErrorCode::InvalidRequest,
                ErrorPhase::Validate,
                "instance_id is not a valid stable identifier".to_string(),
            )
        })?;
    request
        .module_id
        .parse::<ModuleId>()
        .map_err(|_| {
            AssetError::new(
                AssetErrorCode::InvalidRequest,
                ErrorPhase::Validate,
                "module_id is not a valid stable identifier".to_string(),
            )
        })?;
    request.deadline.parse::<Timestamp>().map_err(|_| {
        AssetError::new(
            AssetErrorCode::InvalidRequest,
            ErrorPhase::Validate,
            "deadline must be an RFC3339 UTC timestamp with microsecond precision".to_string(),
        )
    })?;
    // Activation coupling: both or neither.
    match (&request.activation_id, &request.lease_token) {
        (Some(activation), Some(token)) => {
            activation.parse::<UuidV7>().map_err(|_| {
                AssetError::new(
                    AssetErrorCode::InvalidRequest,
                    ErrorPhase::Validate,
                    "activation_id must be a valid UUIDv7".to_string(),
                )
            })?;
            token.parse::<dolly_core_domain::LeaseToken>().map_err(|_| {
                AssetError::new(
                    AssetErrorCode::InvalidRequest,
                    ErrorPhase::Validate,
                    "lease_token is malformed".to_string(),
                )
            })?;
        }
        (None, None) => {}
        _ => {
            return Err(AssetError::new(
                AssetErrorCode::InvalidRequest,
                ErrorPhase::Validate,
                "activation_id and lease_token must be present together".to_string(),
            ))
        }
    }
    match &request.source {
        Source::InlineBase64 { base64 } => {
            if request.declared_media_type.is_none() {
                return Err(AssetError::new(
                    AssetErrorCode::InvalidRequest,
                    ErrorPhase::Validate,
                    "inline_base64 requires a declared media type".to_string(),
                ));
            }
            // Strict base64 is validated before any durable record is
            // written, so an invalid encoding leaves no partial authority.
            crate::source::strict_base64_decoded_len(base64)?;
        }
        Source::RemoteUrl { url, max_bytes } => {
            if *max_bytes == 0 {
                return Err(AssetError::new(
                    AssetErrorCode::InvalidRequest,
                    ErrorPhase::Validate,
                    "remote_url requires a positive max_bytes bound".to_string(),
                ));
            }
            SshDenyPolicy::validate_url(url).map_err(|e| {
                AssetError::new(
                    AssetErrorCode::SourceDenied,
                    ErrorPhase::Validate,
                    format!("remote_url rejected before acquisition: {e:?}"),
                )
            })?;
        }
        Source::Stream { max_bytes, .. } => {
            if *max_bytes == 0 {
                return Err(AssetError::new(
                    AssetErrorCode::InvalidRequest,
                    ErrorPhase::Validate,
                    "stream requires a positive max_bytes bound".to_string(),
                ));
            }
        }
        Source::ModuleFile { .. } | Source::ExistingAsset { .. } => {}
    }
    // remote_required with no configured replica fails before acquisition.
    if request.remote_required && !config.replica_enabled() {
        return Err(AssetError::new(
            AssetErrorCode::RemoteReplicaFailed,
            ErrorPhase::Validate,
            "remote_required import needs a configured object-store replica".to_string(),
        ));
    }
    Ok(())
}

fn params_digest(request: &ImportRequest) -> Result<String, AssetError> {
    let (_, digest) = canonicalize(request).map_err(|e| {
        AssetError::new(
            AssetErrorCode::InvalidRequest,
            ErrorPhase::Validate,
            format!("cannot canonicalize import parameters: {e}"),
        )
    })?;
    Ok(digest.to_string())
}

impl<'a> ImportPipeline<'a> {
    /// Run (or replay) one import to a terminal or durable state.
    pub fn import(
        &mut self,
        security_domain: &str,
        request: &ImportRequest,
    ) -> Result<StatusResult, AssetError> {
        validate_request(self.config, request)?;
        let digest = params_digest(request)?;
        let now = self.clock.now();

        // Replay check. One gate covers every reconciliation: the complete
        // expected identity — exact security domain (from the capability, not
        // the request), module id, module instance id, and the canonical
        // parameter digest — must all match. Any discrepancy is a
        // cause-neutral conflict; absence stays indistinguishable from a
        // record owned by someone else.
        {
            let tx = self.store.transaction().map_err(store_error)?;
            let existing = tx.load_import(&request.import_id).map_err(store_error)?;
            tx.commit().map_err(store_error)?;
            if let Some(record) = existing {
                if !record_matches_identity(&record, security_domain, request, &digest) {
                    return Err(import_id_in_use(&request.import_id));
                }
                return Ok(StatusResult::from_record(&record));
            }
        }

        // Durable ACCEPTED: request, caller, limits, and source descriptor
        // are durable; no bytes are trusted.
        let record = ImportRecord {
            import_id: request.import_id.clone(),
            instance_id: request.instance_id.clone(),
            module_id: request.module_id.clone(),
            security_domain: security_domain.to_string(),
            state: ImportState::Accepted,
            params_digest: digest.clone(),
            media_kind: request.media_kind.as_str().to_string(),
            source_kind: request.source.kind_name().to_string(),
            source_json: serde_json::to_string(&request.source).expect("closed source serializes"),
            declared_media_type: request
                .declared_media_type
                .as_ref()
                .map(|m| m.as_str().to_string()),
            expected_byte_length: request.expected_byte_length,
            remote_required: request.remote_required,
            deadline: request.deadline.clone(),
            max_bytes: request
                .source
                .declared_max_bytes()
                .unwrap_or(self.config.max_decoded_bytes),
            asset_id: None,
            detected_media_type: None,
            byte_length: None,
            encoded_width: None,
            encoded_height: None,
            orientation: None,
            staging_bytes: None,
            staging_hash: None,
            error_code: None,
            error_message: None,
            error_retryable: None,
            error_outcome: None,
            error_details_json: None,
            replica_state: ReplicaState::Disabled,
            replica_attempt: 0,
            retry_at_ms: None,
            created_at: now.iso(),
            updated_at: now.iso(),
            updated_at_ms: now.millis,
        };
        if !self.claim_import_if_absent(&record)? {
            // A concurrent importer won the identifier between this caller's
            // replay read and this insert. The identical identity gate as
            // the replay check decides here, so the losing insert can never
            // bypass the initial owner/digest decision or disclose the
            // winner's lifecycle or AssetRef.
            return self.reconcile_concurrent_winner(security_domain, request, &digest);
        }

        // ACQUIRING: read bytes into a private staging object.
        let sink_name = record.staging_key();
        {
            let tx = self.store.transaction().map_err(store_error)?;
            let result = tx.cas_import(
                &request.import_id,
                ImportState::Accepted,
                ImportState::Acquiring,
                &ImportPatch::default(),
                now,
            );
            tx.commit().map_err(store_error)?;
            if result.is_err() {
                // State already moved (recovery or another writer). Only this
                // caller's record can have moved, because the insert above
                // won the identifier; the owner check still runs for safety.
                return self.return_current_owned(security_domain, request, &digest, &request.import_id);
            }
        }

        let acquired = {
            let mut ctx = AcquireContext {
                config: self.config,
                content_root: self.content_root,
                file_caps: self.file_caps,
                stream_caps: self.stream_caps,
                fetcher: self.fetcher,
                policy: self.policy,
            };
            crate::source::acquire_into_sink(&sink_name, request, &mut ctx)
        };
        let (byte_length, content_hash) = match acquired {
            Ok(result) => result,
            Err(error) => {
                return self.reject(
                    ImportState::Acquiring,
                    &request.import_id,
                    error.with_import_id(&request.import_id),
                    now,
                );
            }
        };
        let content_hash_hex = content_hash.digest_hex();

        // Persist byte accounting, then move to VERIFYING.
        {
            let tx = self.store.transaction().map_err(store_error)?;
            tx.update_import_staging(&request.import_id, byte_length, &content_hash_hex, now)
                .map_err(store_error)?;
            tx.cas_import(
                &request.import_id,
                ImportState::Acquiring,
                ImportState::Verifying,
                &ImportPatch::default(),
                now,
            )
            .map_err(store_error)?;
            tx.commit().map_err(store_error)?;
        }

        // VERIFYING: validate length, media type, decoder safety, metadata.
        let (detected, orientation, encoded_width, encoded_height, display) = match self
            .verify_staging(&record, byte_length, &content_hash)
        {
            Ok(verified) => verified,
            Err(error) => {
                return self.reject(
                    ImportState::Verifying,
                    &request.import_id,
                    error.with_import_id(&request.import_id),
                    now,
                );
            }
        };

        // COMMITTING: verify an immutable durable object, then the mapping.
        {
            let tx = self.store.transaction().map_err(store_error)?;
            let result = tx.cas_import(
                &request.import_id,
                ImportState::Verifying,
                ImportState::Committing,
                &ImportPatch::default(),
                now,
            );
            tx.commit().map_err(store_error)?;
            if result.is_err() {
                return self.return_current_owned(security_domain, request, &digest, &request.import_id);
            }
        }

        let asset_id = AssetId::from_digest(content_hash.digest).to_string();
        let staging_path = self.content_root.join("staging").join(&sink_name);
        if let Err(error) =
            content::commit_object(self.content_root, &staging_path, &asset_id, byte_length, &content_hash)
        {
            return self.reject(
                ImportState::Committing,
                &request.import_id,
                error.with_import_id(&request.import_id),
                now,
            );
        }

        let target = if request.remote_required {
            ImportState::Replicating
        } else {
            ImportState::Available
        };
        let state = match self.commit_mapping(
            &request.import_id,
            security_domain,
            &asset_id,
            &content_hash,
            byte_length,
            request,
            detected,
            orientation,
            encoded_width,
            encoded_height,
            display,
            target,
            now,
        ) {
            Ok(state) => state,
            Err(error) => return Err(error.with_import_id(&request.import_id)),
        };

        if state == ImportState::Replicating {
            let _ = self.replicate(&request.import_id, &asset_id, byte_length, content_hash, now);
        }
        self.return_current_owned(security_domain, request, &digest, &request.import_id)
    }

    /// The VERIFYING body: length, media probe, declared-type check.
    #[allow(clippy::type_complexity)]
    fn verify_staging(
        &mut self,
        record: &ImportRecord,
        byte_length: u64,
        content_hash: &ContentHash,
    ) -> Result<
        (
            Option<String>,
            Option<u8>,
            Option<u64>,
            Option<u64>,
            Option<(u64, u64)>,
        ),
        AssetError,
    > {
        use std::io::Read;
        if let Some(expected) = record.expected_byte_length {
            if expected != byte_length {
                return Err(AssetError::new(
                    AssetErrorCode::SizeLimit,
                    ErrorPhase::Verify,
                    format!("acquired {byte_length} bytes does not match expected {expected}"),
                ));
            }
        }
        let staging = self.content_root.join("staging").join(record.staging_key());
        let mut head = vec![0u8; SNIFF_HEAD_BYTES];
        let mut file = std::fs::File::open(&staging).map_err(|e| {
            AssetError::new(
                AssetErrorCode::Internal,
                ErrorPhase::Verify,
                format!("cannot reopen staging for verification: {e}"),
            )
        })?;
        let head_len = file.read(&mut head).map_err(|e| {
            AssetError::new(
                AssetErrorCode::Internal,
                ErrorPhase::Verify,
                format!("cannot read staging head: {e}"),
            )
        })?;
        head.truncate(head_len);
        // Full-length re-verification of the finished staging file.
        if !content::verify_object(&staging, byte_length, content_hash) {
            return Err(AssetError::new(
                AssetErrorCode::HashMismatch,
                ErrorPhase::Verify,
                "staging file no longer matches its recorded length or digest".to_string(),
            ));
        }
        let probe = media::probe_media_head(&head, self.config.max_image_pixels)?;
        let declared = record
            .declared_media_type
            .as_deref()
            .map(|m| MediaType::parse(m))
            .transpose()
            .map_err(|e| {
                AssetError::new(
                    AssetErrorCode::InvalidRequest,
                    ErrorPhase::Verify,
                    format!("declared media type invalid: {e}"),
                )
            })?;
        media::validate_declared_media(&record.media_kind, declared.as_ref(), probe.detected.as_ref())?;
        let display = match (probe.width, probe.height) {
            (Some(w), Some(h)) => Some(match probe.orientation {
                5..=8 => (h, w),
                _ => (w, h),
            }),
            _ => None,
        };
        Ok((
            probe.detected.map(|m| m.as_str().to_string()),
            Some(probe.orientation),
            probe.width,
            probe.height,
            display,
        ))
    }

    /// Commit the asset row and the import mapping in one transaction.
    #[allow(clippy::too_many_arguments)]
    fn commit_mapping(
        &mut self,
        import_id: &str,
        security_domain: &str,
        asset_id: &str,
        content_hash: &ContentHash,
        byte_length: u64,
        request: &ImportRequest,
        detected: Option<String>,
        orientation: Option<u8>,
        encoded_width: Option<u64>,
        encoded_height: Option<u64>,
        display: Option<(u64, u64)>,
        target: ImportState,
        now: crate::clock::ClockTime,
    ) -> Result<ImportState, AssetError> {
        let hash_hex = content_hash.digest_hex();
        let generation = {
            let tx = self.store.transaction().map_err(store_error)?;
            let existing = tx
                .find_live_asset(&hash_hex, security_domain)
                .map_err(store_error)?;
            let generation = match existing {
                Some((_, generation)) => generation,
                None => tx.next_generation(&hash_hex, security_domain).map_err(store_error)?,
            };
            tx.commit().map_err(store_error)?;
            generation
        };

        let replica_state = if request.remote_required {
            ReplicaState::PendingUpload
        } else {
            ReplicaState::Disabled
        };

        {
            let tx = self.store.transaction().map_err(store_error)?;
            let existing = tx
                .find_live_asset(&hash_hex, security_domain)
                .map_err(store_error)?;
            if existing.as_ref().map(|(_, g)| *g) != Some(generation) || existing.is_none() {
                let record = AssetRecord {
                    asset_id: asset_id.to_string(),
                    security_domain: security_domain.to_string(),
                    generation,
                    content_hash: *content_hash,
                    byte_length,
                    declared_media_type: request
                        .declared_media_type
                        .as_ref()
                        .map(|m| m.as_str().to_string()),
                    detected_media_type: detected.clone(),
                    orientation,
                    encoded_width,
                    encoded_height,
                    display_width: display.map(|(w, _)| w),
                    display_height: display.map(|(_, h)| h),
                    lifecycle: Lifecycle::Live,
                    deletion_generation: 0,
                    local_state: LocalState::Present,
                    replica_state,
                    tombstoned_at: None,
                    created_at: now.iso(),
                    updated_at: now.iso(),
                    updated_at_ms: now.millis,
                };
                tx.insert_asset(&record, now).map_err(store_error)?;
            }
            let patch = ImportPatch {
                asset_id: Some(asset_id.to_string()),
                detected_media_type: detected,
                byte_length: Some(byte_length),
                encoded_width,
                encoded_height,
                orientation,
                replica_state,
                ..ImportPatch::default()
            };
            let result = tx.cas_import(import_id, ImportState::Committing, target, &patch, now);
            tx.commit().map_err(store_error)?;
            match result {
                Ok(()) => Ok(target),
                Err(_) => {
                    // A concurrent mover changed the state (e.g. recovery).
                    let _ = &self;
                    unreachable_state_reconcile()
                }
            }
        }
    }

    /// REPLICATING: upload and verify the replica under the same content
    /// hash. A failure is durable REPLICA_FAILED, never fallback to local.
    fn replicate(
        &mut self,
        import_id: &str,
        asset_id: &str,
        byte_length: u64,
        content_hash: ContentHash,
        now: crate::clock::ClockTime,
    ) -> Result<(), AssetError> {
        let mut bytes = Vec::with_capacity(byte_length as usize);
        {
            let mut reader = ObjectReader::open(self.content_root, asset_id, byte_length)
                .map_err(|e| {
                    AssetError::new(
                        AssetErrorCode::Internal,
                        ErrorPhase::Replicate,
                        format!("cannot open committed object for replica: {e}"),
                    )
                })?;
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = reader.read_bounded(&mut buf).map_err(|e| {
                    AssetError::new(
                        AssetErrorCode::Internal,
                        ErrorPhase::Replicate,
                        format!("cannot read committed object for replica: {e}"),
                    )
                })?;
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buf[..n]);
            }
        }
        let key = self.replica.key_for(asset_id);
        let object = ReplicaObject {
            bucket: "dolly".to_string(),
            key,
            content_hash,
            byte_length,
        };
        let verified = match self.replica.upload(&object, &bytes) {
            crate::replica::ReplicaUploadResult::Uploaded
            | crate::replica::ReplicaUploadResult::AlreadyPresent => self.replica.verify(&object),
            crate::replica::ReplicaUploadResult::Failure(reason) => {
                ReplicaVerifyResult::Failure(reason)
            }
        };
        match verified {
            ReplicaVerifyResult::Verified => {
                let patch = ImportPatch {
                    replica_state: ReplicaState::Present,
                    ..ImportPatch::default()
                };
                let tx = self.store.transaction().map_err(store_error)?;
                tx.cas_import(
                    import_id,
                    ImportState::Replicating,
                    ImportState::Available,
                    &patch,
                    now,
                )
                .map_err(store_error)?;
                tx.commit().map_err(store_error)?;
                Ok(())
            }
            result => {
                let reason = match result {
                    ReplicaVerifyResult::Failure(r) => r,
                    _ => "replica verification failed".to_string(),
                };
                let error = crate::replica::replica_failure(
                    ErrorPhase::Replicate,
                    format!("required replica not verified: {reason}"),
                );
                let patch = ImportPatch {
                    error_code: Some(error.code.to_string()),
                    error_message: Some(error.message.clone()),
                    error_retryable: Some(true),
                    error_outcome: Some("unknown".to_string()),
                    replica_state: ReplicaState::UploadFailed,
                    ..ImportPatch::default()
                };
                let tx = self.store.transaction().map_err(store_error)?;
                tx.cas_import(
                    import_id,
                    ImportState::Replicating,
                    ImportState::ReplicaFailed,
                    &patch,
                    now,
                )
                .map_err(store_error)?;
                tx.commit().map_err(store_error)?;
                Err(error.with_import_id(import_id))
            }
        }
    }

    /// A terminal REJECTED transition with staging deletion.
    fn reject(
        &mut self,
        from: ImportState,
        import_id: &str,
        error: AssetError,
        now: crate::clock::ClockTime,
    ) -> Result<StatusResult, AssetError> {
        let patch = ImportPatch::rejection(&error);
        {
            let tx = self.store.transaction().map_err(store_error)?;
            let result = tx.cas_import(import_id, from, ImportState::Rejected, &patch, now);
            tx.commit().map_err(store_error)?;
            if result.is_err() {
                return self.return_current(import_id);
            }
        }
        content::delete_staging(self.content_root, &format!("staging-{import_id}"));
        self.return_current(import_id)
    }

    /// Read-only status lookup. Never advances the import.
    pub fn status(&mut self, import_id: &str) -> Result<StatusResult, AssetError> {
        self.return_current(import_id)
    }

    /// Cancel a non-terminal import. After availability, cancellation
    /// affects only the request, never the deduplicated asset.
    pub fn cancel(&mut self, import_id: &str) -> Result<StatusResult, AssetError> {
        let now = self.clock.now();
        let existing = {
            let tx = self.store.transaction().map_err(store_error)?;
            let record = tx.load_import(import_id).map_err(store_error)?;
            tx.commit().map_err(store_error)?;
            record
        };
        match existing {
            Some(record) if !record.state.is_terminal() => {
                let tx = self.store.transaction().map_err(store_error)?;
                let result = tx.cas_import(
                    import_id,
                    record.state,
                    ImportState::Cancelled,
                    &ImportPatch::default(),
                    now,
                );
                tx.commit().map_err(store_error)?;
                if result.is_err() {
                    return self.return_current(import_id);
                }
                content::delete_staging(self.content_root, &format!("staging-{import_id}"));
                self.return_current(import_id)
            }
            Some(record) => Ok(StatusResult::from_record(&record)),
            None => Err(AssetError::new(
                AssetErrorCode::NotFound,
                ErrorPhase::Accept,
                "no such import".to_string(),
            )
            .with_import_id(import_id)),
        }
    }

    /// Crash recovery: resolve non-terminal imports after restart.
    pub fn recover(&mut self) -> Result<RecoveryReport, AssetError> {
        let mut report = RecoveryReport::default();
        let now = self.clock.now();
        let non_terminal = [
            ImportState::Acquiring,
            ImportState::Verifying,
            ImportState::Committing,
            ImportState::Replicating,
            ImportState::ReplicaFailed,
        ];
        let rows = self
            .store
            .load_imports_in_states(&non_terminal)
            .map_err(store_error)?;
        for record in rows {
            let import_id = record.import_id.clone();
            match record.state {
                ImportState::Acquiring | ImportState::Verifying => {
                    let complete = record
                        .staging_hash
                        .as_deref()
                        .and_then(|hex| ContentHash::from_digest_hex(hex).ok())
                        .is_some_and(|hash| {
                            content::staging_exists(self.content_root, &record.staging_key())
                                && content::verify_object(
                                    &self.content_root.join("staging").join(record.staging_key()),
                                    record.staging_bytes.unwrap_or(0),
                                    &hash,
                                )
                        });
                    if complete {
                        // Keep the verified staging object at VERIFYING.
                        let tx = self.store.transaction().map_err(store_error)?;
                        let r = tx.cas_import(
                            &import_id,
                            record.state,
                            ImportState::Verifying,
                            &ImportPatch::default(),
                            now,
                        );
                        tx.commit().map_err(store_error)?;
                        if r.is_ok() || record.state == ImportState::Verifying {
                            report.kept_verified += 1;
                        }
                    } else {
                        let tx = self.store.transaction().map_err(store_error)?;
                        tx.cas_import(
                            &import_id,
                            record.state,
                            ImportState::Accepted,
                            &ImportPatch::default(),
                            now,
                        )
                        .map_err(store_error)?;
                        tx.commit().map_err(store_error)?;
                        content::delete_staging(self.content_root, &format!("staging-{import_id}"));
                        report.resumed_from_partial += 1;
                    }
                }
                ImportState::Committing => {
                    if self.resolve_committing(&record, now)? == 1 {
                        report.resolved_committing += 1;
                    }
                }
                ImportState::Replicating | ImportState::ReplicaFailed => {
                    // Requires the replica driver; without a verified remote
                    // object the import stays non-available.
                    report.pending_replicas += 1;
                }
                _ => {}
            }
        }
        Ok(report)
    }

    /// Resolve a COMMITTING record: complete the mapping if the object
    /// verifies, otherwise return to ACCEPTED.
    fn resolve_committing(
        &mut self,
        record: &ImportRecord,
        now: crate::clock::ClockTime,
    ) -> Result<u64, AssetError> {
        let import_id = record.import_id.clone();
        let hash = record
            .staging_hash
            .as_deref()
            .and_then(|hex| ContentHash::from_digest_hex(hex).ok());
        let Some(hash) = hash else {
            self.back_to_accepted(&import_id, now)?;
            return Ok(1);
        };
        let asset_id = record
            .asset_id
            .clone()
            .unwrap_or_else(|| AssetId::from_digest(hash.digest).to_string());
        let object = self.content_root.join("objects").join(&asset_id);
        if content::verify_object(&object, record.byte_length.unwrap_or(0), &hash) {
            self.complete_mapping(record, &asset_id, hash, now)?;
            Ok(1)
        } else {
            self.back_to_accepted(&import_id, now)?;
            Ok(1)
        }
    }

    fn back_to_accepted(
        &mut self,
        import_id: &str,
        now: crate::clock::ClockTime,
    ) -> Result<(), AssetError> {
        let tx = self.store.transaction().map_err(store_error)?;
        tx.cas_import(
            import_id,
            ImportState::Committing,
            ImportState::Accepted,
            &ImportPatch::default(),
            now,
        )
        .map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        Ok(())
    }

    /// Complete a verified mapping for a COMMITTING recovery.
    fn complete_mapping(
        &mut self,
        record: &ImportRecord,
        asset_id: &str,
        hash: ContentHash,
        now: crate::clock::ClockTime,
    ) -> Result<(), AssetError> {
        let security_domain = record.security_domain.clone();
        let replica_verified = record.remote_required
            && self.replica.verify(&ReplicaObject {
                bucket: "dolly".to_string(),
                key: self.replica.key_for(asset_id),
                content_hash: hash,
                byte_length: record.byte_length.unwrap_or(0),
            }) == ReplicaVerifyResult::Verified;
        let (target, replica_state) = if record.remote_required {
            if replica_verified {
                (ImportState::Available, ReplicaState::Present)
            } else {
                (ImportState::Replicating, ReplicaState::PendingUpload)
            }
        } else {
            (ImportState::Available, ReplicaState::Disabled)
        };
        let hash_hex = hash.digest_hex();
        let tx = self.store.transaction().map_err(store_error)?;
        let dedup = tx
            .find_live_asset(&hash_hex, &security_domain)
            .map_err(store_error)?;
        if dedup.is_none() {
            let generation = tx
                .next_generation(&hash_hex, &security_domain)
                .map_err(store_error)?;
            tx.insert_asset(
                &AssetRecord {
                    asset_id: asset_id.to_string(),
                    security_domain,
                    generation,
                    content_hash: hash,
                    byte_length: record.byte_length.unwrap_or(0),
                    declared_media_type: record.declared_media_type.clone(),
                    detected_media_type: record.detected_media_type.clone(),
                    orientation: record.orientation,
                    encoded_width: record.encoded_width,
                    encoded_height: record.encoded_height,
                    display_width: display_swap(
                        record.encoded_width,
                        record.encoded_height,
                        record.orientation,
                    )
                    .0,
                    display_height: display_swap(
                        record.encoded_width,
                        record.encoded_height,
                        record.orientation,
                    )
                    .1,
                    lifecycle: Lifecycle::Live,
                    deletion_generation: 0,
                    local_state: LocalState::Present,
                    replica_state,
                    tombstoned_at: None,
                    created_at: record.created_at.clone(),
                    updated_at: now.iso(),
                    updated_at_ms: now.millis,
                },
                now,
            )
            .map_err(store_error)?;
        }
        let patch = ImportPatch {
            asset_id: Some(asset_id.to_string()),
            replica_state,
            ..ImportPatch::default()
        };
        tx.cas_import(
            &record.import_id,
            ImportState::Committing,
            target,
            &patch,
            now,
        )
        .map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        Ok(())
    }

    /// Read-only replay of the current record for callers already bound to
    /// its owner at the service boundary (`cancel`, `status`, recovery).
    fn return_current(&mut self, import_id: &str) -> Result<StatusResult, AssetError> {
        let tx = self.store.transaction().map_err(store_error)?;
        let record = tx.load_import(import_id).map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        match record {
            Some(record) => Ok(StatusResult::from_record(&record)),
            None => Err(AssetError::new(
                AssetErrorCode::NotFound,
                ErrorPhase::Accept,
                "no such import".to_string(),
            )
            .with_import_id(import_id)),
        }
    }

    /// Read-only replay of the current record through the complete identity
    /// gate. Every import path that returns an existing record goes through
    /// here, so a concurrent winner of the identifier — or the loser of an
    /// `insert_import_if_absent` race — is never disclosed or reused unless
    /// every identity field matches exactly.
    fn return_current_owned(
        &mut self,
        security_domain: &str,
        request: &ImportRequest,
        digest: &str,
        import_id: &str,
    ) -> Result<StatusResult, AssetError> {
        let tx = self.store.transaction().map_err(store_error)?;
        let record = tx.load_import(import_id).map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        let Some(record) = record else {
            return Err(AssetError::new(
                AssetErrorCode::NotFound,
                ErrorPhase::Accept,
                "no such import".to_string(),
            )
            .with_import_id(import_id));
        };
        if !record_matches_identity(&record, security_domain, request, digest) {
            return Err(import_id_in_use(import_id));
        }
        Ok(StatusResult::from_record(&record))
    }

    /// Claim the durable ACCEPTED record for `record`. `Ok(true)` when this
    /// caller won the identifier; `Ok(false)` when a concurrent importer
    /// already owns it — the losing-insert case, which the caller resolves
    /// through [`Self::reconcile_concurrent_winner`].
    fn claim_import_if_absent(
        &mut self,
        record: &ImportRecord,
    ) -> Result<bool, AssetError> {
        let tx = self.store.transaction().map_err(store_error)?;
        let inserted = tx.insert_import_if_absent(record).map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        Ok(inserted)
    }

    /// Reconcile a concurrent winner of the identifier with the identical
    /// identity gate as the replay check, so the losing insert can never
    /// bypass the initial owner/digest decision.
    fn reconcile_concurrent_winner(
        &mut self,
        security_domain: &str,
        request: &ImportRequest,
        digest: &str,
    ) -> Result<StatusResult, AssetError> {
        self.return_current_owned(security_domain, request, digest, &request.import_id)
    }
}

/// The complete expected identity an existing record must match for this
/// caller to replay it: exact security domain, module id, module instance
/// id, and the canonical parameter digest. The security domain comes from
/// the caller's capability and is never part of the request or its digest,
/// so it is checked explicitly.
fn record_matches_identity(
    record: &ImportRecord,
    security_domain: &str,
    request: &ImportRequest,
    digest: &str,
) -> bool {
    record.security_domain == security_domain
        && record.module_id == request.module_id
        && record.instance_id == request.instance_id
        &&         record.params_digest == digest
}

/// The nondisclosing refusal for an ImportId owned by another importer. The
/// message never reveals who owns the identifier — only that it is not
/// reusable by this caller — so a foreign security domain cannot learn that
/// its domain-specific absence is hiding another domain's record.
fn import_id_in_use(import_id: &str) -> AssetError {
    AssetError::new(
        AssetErrorCode::ImportIdConflict,
        ErrorPhase::Validate,
        "ImportId is already in use".to_string(),
    )
    .with_import_id(import_id)
}

fn display_swap(
    encoded_width: Option<u64>,
    encoded_height: Option<u64>,
    orientation: Option<u8>,
) -> (Option<u64>, Option<u64>) {
    match (encoded_width, encoded_height, orientation) {
        (Some(w), Some(h), Some(5..=8)) => (Some(h), Some(w)),
        (Some(w), Some(h), _) => (Some(w), Some(h)),
        _ => (None, None),
    }
}

/// The CAS conflict path is reconciled by the caller via `return_current`;
/// this helper exists only to keep the branch explicit and unreachable from a
/// single-writer service.
fn unreachable_state_reconcile() -> Result<ImportState, AssetError> {
    Err(AssetError::new(
        AssetErrorCode::Internal,
        ErrorPhase::Commit,
        "concurrent state change requires reconciliation".to_string(),
    ))
}

fn store_error(error: StoreError) -> AssetError {
    match error {
        StoreError::IllegalTransition { from, to } => AssetError::new(
            AssetErrorCode::Internal,
            ErrorPhase::Commit,
            format!("illegal state transition {from:?} -> {to:?}"),
        ),
        StoreError::Conflict(message) => AssetError::new(
            AssetErrorCode::Internal,
            ErrorPhase::Commit,
            format!("state conflict: {message}"),
        ),
        StoreError::NotFound(message) => {
            AssetError::new(AssetErrorCode::NotFound, ErrorPhase::Accept, message)
        }
        StoreError::Integrity(message) => AssetError::new(
            AssetErrorCode::Internal,
            ErrorPhase::Commit,
            format!("store integrity failure: {message}"),
        ),
        StoreError::Sqlite(e) => AssetError::new(
            AssetErrorCode::Internal,
            ErrorPhase::Commit,
            format!("sqlite failure: {e}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::SystemClock;
    use crate::remote::DeniedFetcher;
    use crate::replica::DisabledReplica;
    use crate::service::{FileCapabilityTable, StreamCapabilityTable};
    use crate::store::AssetStore;
    use std::path::Path;

    const T0: u64 = 1_800_000_000_000;

    fn import_id(n: u64) -> String {
        format!("0198ab31-6c44-7e8a-b2bb-{n:012}")
    }

    fn deadline() -> String {
        "2026-08-09T15:00:00.000000Z".to_string()
    }

    /// A minimal byte sequence that sniffs as a 4x2 PNG.
    fn png_bytes() -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(&[0, 0, 0, 13]);
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&4u32.to_be_bytes());
        bytes.extend_from_slice(&2u32.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes.extend_from_slice(&[0u8; 24]);
        bytes
    }

    const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    fn base64(bytes: &[u8]) -> String {
        let mut out = String::new();
        let mut acc: u32 = 0;
        let mut bits: u32 = 0;
        for &b in bytes {
            acc = (acc << 8) | b as u32;
            bits += 8;
            while bits >= 6 {
                bits -= 6;
                out.push(B64[((acc >> bits) & 0x3f) as usize] as char);
            }
        }
        if bits > 0 {
            out.push(B64[((acc << (6 - bits)) & 0x3f) as usize] as char);
        }
        while out.len() % 4 != 0 {
            out.push('=');
        }
        out
    }

    fn request(id: u64, png: &[u8]) -> ImportRequest {
        ImportRequest {
            import_id: import_id(id),
            instance_id: "instance-a".to_string(),
            module_id: "module-a".to_string(),
            activation_id: None,
            lease_token: None,
            media_kind: MediaKind::Image,
            source: Source::InlineBase64 { base64: base64(png) },
            declared_media_type: Some(MediaType::parse("image/png").unwrap()),
            remote_required: false,
            expected_byte_length: None,
            deadline: deadline(),
        }
    }

    fn config_at(dir: &Path) -> ResolvedAssetConfig {
        let mut config = ResolvedAssetConfig::with_local_root(dir.to_path_buf());
        config.max_decoded_bytes = 64 * 1024;
        config.max_inline_base64_chars = 128 * 1024;
        config.max_image_pixels = 1_000_000;
        config.gc_grace_ms = 60_000;
        config
    }

    /// A pipeline over a fresh durable store, holding every dependency in
    /// one scope so the test can drive the exact reconciliation branches.
    struct Harness {
        _dir: tempfile::TempDir,
        store: AssetStore,
        config: ResolvedAssetConfig,
        clock: SystemClock,
        file_caps: FileCapabilityTable,
        stream_caps: StreamCapabilityTable,
        fetcher: DeniedFetcher,
        policy: SshDenyPolicy,
        replica: DisabledReplica,
    }

    impl Harness {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let store = AssetStore::open(&dir.path().join("asset-store.sqlite")).unwrap();
            let config = config_at(dir.path());
            Self {
                _dir: dir,
                store,
                config,
                clock: SystemClock,
                file_caps: FileCapabilityTable::default(),
                stream_caps: StreamCapabilityTable::default(),
                fetcher: DeniedFetcher,
                policy: SshDenyPolicy::new(&[]),
                replica: DisabledReplica::new("assets"),
            }
        }

        fn pipeline(&mut self) -> ImportPipeline<'_> {
            ImportPipeline {
                store: &mut self.store,
                config: &self.config,
                content_root: &self._dir.path(),
                clock: &mut self.clock,
                file_caps: &self.file_caps,
                stream_caps: &mut self.stream_caps,
                fetcher: &mut self.fetcher,
                policy: &self.policy,
                replica: &mut self.replica,
            }
        }
    }

    /// An ACCEPTED record owned by `security_domain` with a real canonical
    /// digest, ready to claim under a fresh identifier.
    fn accepted_record(security_domain: &str, id: &str, digest: &str) -> ImportRecord {
        ImportRecord {
            import_id: id.to_string(),
            instance_id: "instance-a".to_string(),
            module_id: "module-a".to_string(),
            security_domain: security_domain.to_string(),
            state: ImportState::Accepted,
            params_digest: digest.to_string(),
            media_kind: "image".to_string(),
            source_kind: "inline_base64".to_string(),
            source_json: "{}".to_string(),
            declared_media_type: Some("image/png".to_string()),
            expected_byte_length: None,
            remote_required: false,
            deadline: deadline(),
            max_bytes: 64 * 1024,
            asset_id: None,
            detected_media_type: None,
            byte_length: None,
            encoded_width: None,
            encoded_height: None,
            orientation: None,
            staging_bytes: None,
            staging_hash: None,
            error_code: None,
            error_message: None,
            error_retryable: None,
            error_outcome: None,
            error_details_json: None,
            replica_state: ReplicaState::Disabled,
            replica_attempt: 0,
            retry_at_ms: None,
            created_at: "2026-08-09T15:00:00.000000Z".to_string(),
            updated_at: "2026-08-09T15:00:00.000000Z".to_string(),
            updated_at_ms: T0,
        }
    }

    /// An AVAILABLE record owned by `security_domain` carrying a real
    /// canonical AssetRef, used to prove the identity gate still returns the
    /// authoritative record on a true replay while refusing every mismatch.
    fn available_record(security_domain: &str, id: &str, digest: &str) -> ImportRecord {
        let mut record = accepted_record(security_domain, id, digest);
        record.state = ImportState::Available;
        record.asset_id = Some(AssetId::from_digest([1u8; 32]).to_string());
        record.detected_media_type = Some("image/png".to_string());
        record.byte_length = Some(123);
        record.encoded_width = Some(4);
        record.encoded_height = Some(2);
        record.orientation = Some(1);
        record
    }

    #[test]
    fn losing_insert_reconciliation_is_deterministic_and_identity_gated() {
        let mut harness = Harness::new();
        let png = png_bytes();
        let request = request(801, &png);
        let digest = params_digest(&request).unwrap();

        // 1. Both contenders observe absence before anyone claims the id.
        assert_eq!(
            harness
                .store
                .transaction()
                .unwrap()
                .load_import(&import_id(801))
                .unwrap(),
            None,
            "both contenders observe absence first"
        );

        // 2. One domain wins real insert through the public import path.
        let winner = harness.pipeline().import("work", &request).unwrap();
        assert_eq!(winner.state, "available");

        // 3. The other domain loses the insert: the same claim primitive the
        //    pipeline uses reports the identifier is already taken.
        let loser_record = accepted_record("personal", &import_id(801), &digest);
        assert!(
            !harness.pipeline().claim_import_if_absent(&loser_record).unwrap(),
            "the losing contender specifically loses the insert"
        );

        // 4. The losing-insert reconciliation runs the identical identity
        //    gate as the replay check: cause-neutral refusal, no lifecycle
        //    state, no AssetRef, no mutation.
        let refusal = harness
            .pipeline()
            .reconcile_concurrent_winner("personal", &request, &digest)
            .unwrap_err();
        assert_eq!(refusal.code, AssetErrorCode::ImportIdConflict);
        assert_eq!(refusal.message, "ImportId is already in use");
        assert!(refusal.asset_id.is_none(), "no AssetRef disclosure");
        assert_eq!(
            harness.store.load_import_count().unwrap(),
            1,
            "the refusal creates no second record"
        );
        let winner_record = {
            let tx = harness.store.transaction().unwrap();
            let record = tx.load_import(&import_id(801)).unwrap().unwrap();
            tx.commit().unwrap();
            record
        };
        assert_eq!(
            winner_record.security_domain, "work",
            "the winning record is unmodified"
        );
        assert_eq!(winner_record.state, ImportState::Available);
        assert!(winner_record.asset_id.is_some(), "the winner's AssetRef is intact");
    }

    #[test]
    fn identity_gate_returns_authoritative_replay_only_on_complete_match() {
        let mut harness = Harness::new();
        let png = png_bytes();
        let request = request(802, &png);
        let digest = params_digest(&request).unwrap();
        let id = import_id(802);

        // Seed an owned AVAILABLE record with the real expected digest.
        let owned = available_record("personal", &id, &digest);
        assert!(harness.pipeline().claim_import_if_absent(&owned).unwrap());

        // True same-owner same-digest replay returns the authoritative record
        // with its canonical AssetRef.
        let replay = harness
            .pipeline()
            .reconcile_concurrent_winner("personal", &request, &digest)
            .unwrap();
        assert_eq!(replay.state, "available");
        let asset = replay.asset.expect("true replay carries the authoritative AssetRef");
        assert_eq!(
            asset.asset_id,
            AssetId::from_digest([1u8; 32]),
            "the same canonical AssetRef is returned"
        );

        // Any single identity mismatch is the identical cause-neutral refusal.
        for (label, domain, contender_request, contender_digest) in [
            ("other domain", "work", request.clone(), digest.clone()),
            (
                "other module",
                "personal",
                {
                    let mut r = request.clone();
                    r.module_id = "module-b".to_string();
                    r
                },
                digest.clone(),
            ),
            (
                "other instance",
                "personal",
                {
                    let mut r = request.clone();
                    r.instance_id = "instance-b".to_string();
                    r
                },
                digest.clone(),
            ),
            (
                "different parameters",
                "personal",
                request.clone(),
                params_digest(&ImportRequest {
                    declared_media_type: Some(MediaType::parse("image/jpeg").unwrap()),
                    ..request.clone()
                })
                .unwrap(),
            ),
        ] {
            let refusal = harness
                .pipeline()
                .reconcile_concurrent_winner(domain, &contender_request, &contender_digest)
                .unwrap_err();
            assert_eq!(refusal.code, AssetErrorCode::ImportIdConflict, "{label}");
            assert_eq!(refusal.message, "ImportId is already in use", "{label}");
            assert!(refusal.asset_id.is_none(), "{label}: no AssetRef disclosure");
        }

        // The owned record was never mutated by the refused contenders.
        let after = {
            let tx = harness.store.transaction().unwrap();
            let record = tx.load_import(&id).unwrap().unwrap();
            tx.commit().unwrap();
            record
        };
        assert_eq!(after.security_domain, "personal");
        assert_eq!(after.params_digest, digest);
        assert_eq!(after.state, ImportState::Available);
    }
}
