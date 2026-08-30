//! Committed targeted-Action outbound consumer (seam D) — the single
//! production path.
//!
//! Direction is invariant: a committed, targeted `org.dolly.channel.send`
//! Action selected ONLY from the authoritative immutable Core journal/
//! operation snapshot, bound to the exact sealed current authority/grant ->
//! durable `Prepared` outbound record -> bounded caller-deadline queue ->
//! status-capable transport -> durable exact result/echo marker (atomically,
//! in the single Channel DB transaction).
//!
//! The consumer is SEALED: it reads committed Blocks only through its own
//! internal [`CoreSnapshot`] reader over the authoritative Runtime DB
//! (`SqliteCoreStore::snapshot` loads + verifies the immutable Core journal),
//! never from a caller-supplied source or generic Block scan. Every consume
//! and reconcile pass revalidates the current sealed Host authority/grant and
//! the exact principal fences. There is no public trait a caller can
//! implement to feed arbitrary Blocks or `SendAction`s into the transport
//! path.

use dolly_core_reducer::{ActivationState, CoreSnapshot, InstanceMode};
use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority, SqliteCoreStore};
use serde_json::Value;

use crate::clock::Clock;
use crate::config::ChannelConfig;
use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::ledger::{ChannelLedger, OutboundEntry, OutboundState};
use crate::outbound::{
    SendDispatchResult, build_prepared_entry, prepare_transport_request,
    settle_pre_effect_rejection, transport_and_settle, validate_prepared_transport_for_send,
};
use crate::outbound_committed::CommittedSendAction;
use crate::outbound_queue::OutboundQueueGate;
use crate::principal::ChannelPrincipal;
use crate::store::{
    DispatchClaim, DurableOutboundRecord, OutboundPreparedOutcome, QueuedRecordUpdate,
    SqliteChannelStore,
};
/// The one currently executing activation and its frozen manifest.
struct AuthoritativeManifest {
    activation_id: String,
    digest: String,
    manifest: Value,
    configured_pages: std::collections::BTreeSet<String>,
}

/// The closed outcome of processing one committed Action.
#[derive(Debug, Clone, PartialEq)]
pub enum ConsumerOutcome {
    /// A terminal, frozen `ActionResult` canonical bytes are durable.
    Terminal {
        action_id: String,
        state: OutboundState,
        result_jcs: String,
    },
    /// The send is pending (dispatch marker durable, outcome still unknown);
    /// it MUST NOT be treated as success and is never blind-resent.
    Pending { action_id: String },
    /// Rejected deterministically (authority, conflict, validation, rate or
    /// queue backpressure) with zero transport effect and zero leaked slot.
    Rejected {
        action_id: String,
        error: ChannelError,
    },
}

/// The single sealed production outbound consumer over one module-scoped
/// Channel DB and the authoritative Runtime Core snapshot. Committed actions
/// are selected internally from the journal-verified Core snapshot; no caller
/// can inject Blocks or `SendAction`s.
pub struct OutboundConsumer<'store, 'core, 'principal> {
    config: ChannelConfig,
    clock: Box<dyn Clock>,
    store: SqliteChannelStore<'store>,
    core: SqliteCoreStore<'core>,
    transport: Box<dyn crate::transport::ChannelTransport>,
    /// The ONE identity-enforced outbound gate+limiter per store/account,
    /// injected by the sole integrator (C). It owns the caller-deadline
    /// waiter gate AND the configured per-session rate limiters, so
    /// constructors never create independent gates/buckets.
    gate: std::sync::Arc<OutboundQueueGate>,
    /// The single injected Asset-authority seam for ordered multimodal
    /// sends (sole integrator: the Host/Runtime). The default
    /// [`crate::asset::DenyAssetParts`] keeps the accepted G4 constructor
    /// text-only and fail-closed; only
    /// [`OutboundConsumer::with_asset_preparation`] enables asset parts.
    asset_preparation: Box<dyn crate::asset::AssetPreparation>,
    /// Test-support barrier invoked immediately before each post-blocking
    /// authority check.
    #[cfg(feature = "test-support")]
    effect_hook: Option<std::sync::Arc<dyn Fn(&str) + Send + Sync>>,
    authority: &'principal HostConnectionAuthority,
    grant: &'principal HostCapabilityGrant,
    principal: ChannelPrincipal,
}

/// Admission result of one Action.
enum AdmitResult {
    /// The Action was durably admitted (row `Queued`) and awaits the
    /// dispatch CAS in FIFO order.
    Admitted(CommittedSendAction),
    /// No transport is needed/possible for this Action on this pass;
    /// its terminal/refused outcome is final for the pass.
    Outcome(ConsumerOutcome),
}

impl<'store, 'core, 'principal> OutboundConsumer<'store, 'core, 'principal> {
    /// Open the module store and accept only a gate created by
    /// [`OutboundQueueGate::register`] for the exact same store owner,
    /// account, config revision, and limits. No consumer constructor creates
    /// admission or rate state.

    pub fn new(
        config: ChannelConfig,
        clock: Box<dyn Clock>,
        module_connection: &'store mut rusqlite::Connection,
        runtime_connection: &'core mut rusqlite::Connection,
        gate: std::sync::Arc<OutboundQueueGate>,
        transport: Box<dyn crate::transport::ChannelTransport>,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
    ) -> Result<Self, ChannelError> {
        Self::create(
            config,
            clock,
            module_connection,
            runtime_connection,
            gate,
            transport,
            Box::new(crate::asset::DenyAssetParts),
            authority,
            grant,
        )
    }

    /// Open the module store, accepting only a gate created by
    /// [`OutboundQueueGate::register`] for the exact same store owner,
    /// account, config revision, and limits, and inject the sole
    /// Asset-authority seam for ordered multimodal sends. The default
    /// [`OutboundConsumer::new`] constructor remains the accepted v1
    /// text-only G4 path and stays fail-closed on asset parts; this explicit
    /// constructor is the single production injection seam for the sole
    /// runtime integrator. It is not a second dispatcher and exposes no
    /// public caller-shaped raw dispatch surface.
    pub fn with_asset_preparation(
        config: ChannelConfig,
        clock: Box<dyn Clock>,
        module_connection: &'store mut rusqlite::Connection,
        runtime_connection: &'core mut rusqlite::Connection,
        gate: std::sync::Arc<OutboundQueueGate>,
        transport: Box<dyn crate::transport::ChannelTransport>,
        asset_preparation: Box<dyn crate::asset::AssetPreparation>,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
    ) -> Result<Self, ChannelError> {
        Self::create(
            config,
            clock,
            module_connection,
            runtime_connection,
            gate,
            transport,
            asset_preparation,
            authority,
            grant,
        )
    }

    /// Open the module store and wire the injected seam; shared by the
    /// accepted text-only and the explicit multimodal constructors. No
    /// consumer constructor creates admission, rate, or Asset state.
    fn create(
        config: ChannelConfig,
        clock: Box<dyn Clock>,
        module_connection: &'store mut rusqlite::Connection,
        runtime_connection: &'core mut rusqlite::Connection,
        gate: std::sync::Arc<OutboundQueueGate>,
        transport: Box<dyn crate::transport::ChannelTransport>,
        asset_preparation: Box<dyn crate::asset::AssetPreparation>,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
    ) -> Result<Self, ChannelError> {
        let principal = ChannelPrincipal::from_authority_grant(authority, grant)?;
        if config.extension_id != principal.extension_id() {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "channel config Extension does not match the granted Channel Extension",
            ));
        }
        if config.module_id != principal.module_id() {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "channel config Module does not match the granted Module",
            ));
        }
        let mut config = config;
        config.transport_account = principal.account().to_string();
        let store = SqliteChannelStore::new(module_connection, &principal, config.revision)?;
        gate.verify_identity(
            &store,
            principal.account(),
            config.revision,
            config.outbound_limits,
        )?;
        let core = SqliteCoreStore::new(runtime_connection).map_err(|error| {
            ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::NotApplied,
                format!("core snapshot store unavailable: {error}"),
            )
        })?;
        if !transport.idempotency_supported() {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "the outbound transport must be idempotency-keyed (durable idempotency keys are required before any transport effect)",
            ));
        }
        Ok(Self {
            config,
            clock,
            store,
            core,
            transport,
            gate,
            asset_preparation,
            #[cfg(feature = "test-support")]
            effect_hook: None,
            authority,
            grant,
            principal,
        })
    }

    /// Test-support only: build over a pre-opened store so failpoints can be
    /// injected while enforcing store/principal equality; the injected
    /// Asset-authority seam is explicit here as well.
    #[cfg(feature = "test-support")]
    pub fn new_with_store(
        config: ChannelConfig,
        clock: Box<dyn Clock>,
        store: SqliteChannelStore<'store>,
        runtime_connection: &'core mut rusqlite::Connection,
        gate: std::sync::Arc<OutboundQueueGate>,
        transport: Box<dyn crate::transport::ChannelTransport>,
        asset_preparation: Box<dyn crate::asset::AssetPreparation>,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
    ) -> Result<Self, ChannelError> {
        let principal = ChannelPrincipal::from_authority_grant(authority, grant)?;
        if config.extension_id != principal.extension_id() {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "channel config Extension does not match the granted Channel Extension",
            ));
        }
        if config.module_id != principal.module_id() {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "channel config Module does not match the granted Module",
            ));
        }
        let mut config = config;
        config.transport_account = principal.account().to_string();
        store.verify_owner_against(&principal, config.revision)?;
        gate.verify_identity(
            &store,
            principal.account(),
            config.revision,
            config.outbound_limits,
        )?;
        let core = SqliteCoreStore::new(runtime_connection).map_err(|error| {
            ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::NotApplied,
                format!("core snapshot store unavailable: {error}"),
            )
        })?;
        if !transport.idempotency_supported() {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "the outbound transport must be idempotency-keyed (durable idempotency keys are required before any transport effect)",
            ));
        }
        Ok(Self {
            config,
            clock,
            store,
            core,
            transport,
            gate,
            asset_preparation,
            #[cfg(feature = "test-support")]
            effect_hook: None,
            authority,
            grant,
            principal,
        })
    }

    /// Shared notification gate for additional consumers of this exact store
    /// identity.
    pub fn gate(&self) -> std::sync::Arc<OutboundQueueGate> {
        std::sync::Arc::clone(&self.gate)
    }

    /// Durably cancel an admission that is still Waiting. A concurrent grant
    /// serializes on the same SQLite lock, so cancellation never rolls back a
    /// Queued row.
    pub fn cancel_pending(&mut self, action_key: &str) -> Result<bool, ChannelError> {
        self.gate.cancel(&mut self.store, action_key, &*self.clock)
    }

    /// Test-support: install a barrier hook invoked at each effect boundary.
    #[cfg(feature = "test-support")]
    pub fn set_effect_barrier(&mut self, hook: std::sync::Arc<dyn Fn(&str) + Send + Sync>) {
        self.effect_hook = Some(hook);
    }

    #[cfg(not(feature = "test-support"))]
    fn effect_ts(&self, _label: &str) {}
    #[cfg(feature = "test-support")]
    fn effect_ts(&self, label: &str) {
        if let Some(hook) = &self.effect_hook {
            hook(label);
        }
    }

    /// The current in-memory Channel ledger projection (sessions + durable
    /// outbound rows + echo markers), rebuilt from the single durable source
    /// of truth.
    pub fn ledger(&mut self) -> Result<ChannelLedger, ChannelError> {
        self.store.project_ledger()
    }

    /// The durable outbound queue occupancy: every nonterminal outbound row
    /// (Prepared/Queued/Dispatched), reconstructed from the single durable
    /// source in FIFO order. Test/inspection seam.
    pub fn pending_outbound(&mut self) -> Result<Vec<OutboundEntry>, ChannelError> {
        Ok(self
            .store
            .fifo_pending()?
            .into_iter()
            .map(|record| record.entry)
            .collect())
    }

    /// Revalidate the current sealed authority against BOTH the in-memory
    /// principal fences and the authoritative current capability grant in the
    /// Core store (unrevoked, same grant). A revoked grant, a replaced grant
    /// (generation/incarnation/config/graph change), or a fence mismatch
    /// fails closed with `CHANNEL_AUTHENTICATION_FAILED` before any durable
    /// or transport effect.
    /// Revalidate the installed Extension capability record. Its
    /// `manifest_revision` and `manifest_digest` identify the installed
    /// Extension manifest; they are deliberately opaque here and are never
    /// compared with an Activation Manifest or resolved Activation config.
    fn validate_extension_grant_identity(&self) -> Result<(), ChannelError> {
        if self.grant.extension_id() != self.config.extension_id
            || self.grant.module_id() != self.config.module_id
            || self.grant.manifest_revision() < 1
            || self.grant.manifest_digest().is_empty()
        {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "the installed Extension capability identity is invalid for this Channel module",
            ));
        }
        Ok(())
    }
    fn revalidate_current_grant(&mut self) -> Result<(), ChannelError> {
        self.validate_extension_grant_identity()?;
        let current_principal = ChannelPrincipal::from_authority_grant(self.authority, self.grant)?;
        if current_principal != self.principal {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "the current authority/grant fences changed since the outbound consumer opened",
            ));
        }
        let current_grant = self
            .core
            .current_host_capability_grant(
                self.authority,
                &self.config.extension_id,
                &self.config.module_id,
            )
            .map_err(|error| {
                ChannelError::new(
                    codes::INTERNAL,
                    false,
                    ChannelOutcome::NotApplied,
                    format!("current capability grant unavailable: {error}"),
                )
            })?;
        match current_grant {
            Some(grant) if grant == *self.grant => Ok(()),
            Some(_) => Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "the installed Extension capability changed (manifest/descriptor/generation/lifecycle/graph)",
            )),
            None => Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "the capability grant was revoked",
            )),
        }
    }
    /// Load the one currently dispatched Activation for this module.
    /// Persisted historical Activations are ignored. The Activation Manifest
    /// is validated against its Core Activation/lease, current graph and
    /// resolved Channel config; Extension-manifest identity remains separate.
    fn authoritative_manifest(&mut self) -> Result<Option<AuthoritativeManifest>, ChannelError> {
        self.revalidate_current_grant()?;
        let snapshot = self.core.snapshot().map_err(|error| {
            ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::NotApplied,
                format!("authoritative core snapshot unavailable: {error}"),
            )
        })?;
        let rejected = |message: &str| {
            ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                message,
            )
        };
        if snapshot.mode != InstanceMode::Running {
            return Err(rejected(
                "Core is not running; no activation may produce a Channel effect",
            ));
        }
        if snapshot.graph.get("revision").and_then(Value::as_i64)
            != Some(self.grant.graph_revision())
            || snapshot.graph.get("digest").and_then(Value::as_str)
                != Some(self.grant.graph_digest())
        {
            return Err(rejected(
                "the current graph does not match the capability grant",
            ));
        }
        let descriptor = snapshot
            .graph
            .get("graph")
            .and_then(|graph| graph.get("descriptors"))
            .and_then(Value::as_object)
            .and_then(|descriptors| descriptors.get(&self.config.module_id))
            .ok_or_else(|| {
                rejected("the current graph has no descriptor for the Channel module")
            })?;
        if descriptor
            .get("descriptor_revision")
            .and_then(Value::as_i64)
            != Some(self.grant.descriptor_revision())
            || descriptor
                .get("source_descriptor_digest")
                .and_then(Value::as_str)
                != Some(self.grant.descriptor_digest())
        {
            return Err(rejected(
                "the current module descriptor does not match the capability grant",
            ));
        }
        let frozen_config =
            serde_json::to_value(&self.config).expect("validated Channel config serializes");
        let frozen_config_digest = dolly_canonical_json::canonicalize(&frozen_config)
            .map_err(|_| rejected("the Channel config is not canonical JSON"))?
            .1
            .to_canonical_string();
        let mut selected = Vec::new();
        for (activation_id, activation) in &snapshot.activations {
            let Some(manifest) = activation.manifest.as_ref() else {
                continue;
            };
            if manifest.get("module_id").and_then(Value::as_str)
                != Some(self.config.module_id.as_str())
                || activation.state != ActivationState::Dispatched
            {
                continue;
            }
            let digest = crate::outbound_committed::verified_manifest_digest(manifest)
                .map_err(|_| rejected("the current manifest digest is invalid"))?;
            if manifest.get("activation_id").and_then(Value::as_str) != Some(activation_id.as_str())
                || manifest.get("reason").and_then(Value::as_str) != Some("input")
                || manifest.get("graph_revision").and_then(Value::as_i64)
                    != snapshot.graph.get("revision").and_then(Value::as_i64)
                || manifest.get("config_revision").and_then(Value::as_i64)
                    != Some(self.config.revision)
                || manifest.get("descriptor_revision").and_then(Value::as_i64)
                    != descriptor
                        .get("descriptor_revision")
                        .and_then(Value::as_i64)
                || manifest.get("effective_config") != Some(&frozen_config)
                || manifest
                    .get("effective_config_digest")
                    .and_then(Value::as_str)
                    != Some(frozen_config_digest.as_str())
                || activation.extension_generation != Some(self.grant.extension_generation())
            {
                return Err(rejected(
                    "the active Manifest does not match its current Activation, graph, or resolved config",
                ));
            }
            let live_lease_count = snapshot
                .leases
                .values()
                .filter(|lease| {
                    lease.get("activation_id").and_then(Value::as_str)
                        == Some(activation_id.as_str())
                        && lease.get("manifest_digest").and_then(Value::as_str)
                            == Some(digest.as_str())
                        && lease.get("extension_generation").and_then(Value::as_i64)
                            == Some(self.grant.extension_generation())
                        && lease.get("extension_connection_id").and_then(Value::as_str)
                            == Some(self.grant.extension_connection_id())
                        && lease.get("worker_epoch").and_then(Value::as_i64)
                            == Some(self.grant.worker_epoch_fence())
                        && lease.get("state").and_then(Value::as_str) == Some("leased")
                        && matches!(
                            lease.get("dispatch_state").and_then(Value::as_str),
                            Some("started" | "transport_started")
                        )
                })
                .count();
            if live_lease_count != 1 {
                return Err(rejected(
                    "the active Manifest does not have exactly one current live lease",
                ));
            }
            selected.push((activation_id.clone(), digest, manifest.clone()));
        }
        if selected.len() > 1 {
            return Err(rejected(
                "Core has more than one current dispatched Channel Activation",
            ));
        }
        let Some((activation_id, digest, manifest)) = selected.pop() else {
            return Ok(None);
        };
        Ok(Some(AuthoritativeManifest {
            activation_id,
            digest,
            configured_pages: configured_input_pages(&snapshot, &self.config.module_id),
            manifest,
        }))
    }

    fn revalidate_committed_action(
        &mut self,
        committed: &CommittedSendAction,
    ) -> Result<(), ChannelError> {
        let current = self.authoritative_manifest()?.ok_or_else(|| {
            ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "the manifest that authorized this send is no longer current",
            )
        })?;
        if current.activation_id != committed.activation_id
            || current.digest != committed.manifest_digest
        {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "the manifest that authorized this send is no longer current",
            ));
        }
        Ok(())
    }

    fn revalidate_durable_record(
        &mut self,
        record: &DurableOutboundRecord,
    ) -> Result<(), ChannelError> {
        let current = self.authoritative_manifest()?.ok_or_else(|| {
            ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "the manifest that authorized this durable send is no longer current",
            )
        })?;
        if current.activation_id != record.activation_id
            || current.digest != record.manifest_digest
            || record.config_revision != self.config.revision
        {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "the manifest that authorized this durable send is no longer current",
            ));
        }
        Ok(())
    }
    /// Validate a status response completely before changing the projected
    /// entry. Confirmed identifiers and Partial ordinals must form exact,
    /// non-empty, duplicate-free sets.
    fn settle_status(
        &mut self,
        record: &DurableOutboundRecord,
        status: crate::transport::TransportStatusResult,
    ) -> Result<Option<OutboundEntry>, ChannelError> {
        let action_id = &record.outbound_key;
        let invalid = |message: &str| {
            ChannelError::new(
                codes::MALFORMED_EVENT,
                false,
                ChannelOutcome::NotApplied,
                format!("invalid transport status for {action_id}: {message}"),
            )
        };
        let expected: std::collections::BTreeSet<u32> =
            (0..record.entry.pieces.len() as u32).collect();
        let actual: std::collections::BTreeSet<u32> = record
            .entry
            .pieces
            .iter()
            .map(|piece| piece.ordinal)
            .collect();
        if actual != expected || actual.len() != record.entry.pieces.len() {
            return Err(invalid(
                "durable piece ordinals are not exact and contiguous",
            ));
        }
        let mut entry = record.entry.clone();
        match status {
            crate::transport::TransportStatusResult::Confirmed { message_ids } => {
                if message_ids.len() != expected.len() || message_ids.iter().any(String::is_empty) {
                    return Err(invalid(
                        "Confirmed IDs are missing, empty, gapped, or out of range",
                    ));
                }
                let unique: std::collections::BTreeSet<&str> =
                    message_ids.iter().map(String::as_str).collect();
                if unique.len() != message_ids.len() {
                    return Err(invalid("Confirmed IDs contain duplicates"));
                }
                for piece in &mut entry.pieces {
                    let id = message_ids[piece.ordinal as usize].clone();
                    piece.transport_message_id = Some(id.clone());
                    piece.outcome = Some(crate::ledger::PieceOutcome::Confirmed {
                        transport_message_id: id,
                    });
                }
            }
            crate::transport::TransportStatusResult::Partial { pieces } => {
                if pieces.len() != expected.len() {
                    return Err(invalid(
                        "Partial outcomes are missing, gapped, or out of range",
                    ));
                }
                let observed: std::collections::BTreeSet<u32> =
                    pieces.iter().map(|piece| piece.ordinal()).collect();
                if observed != expected || observed.len() != pieces.len() {
                    return Err(invalid(
                        "Partial ordinals are duplicate, gapped, or out of range",
                    ));
                }
                let confirmed_ids: Vec<&str> = pieces
                    .iter()
                    .filter_map(|piece| match piece {
                        crate::transport::TransportPieceOutcome::Confirmed {
                            message_id, ..
                        } => Some(message_id.as_str()),
                        _ => None,
                    })
                    .collect();
                if confirmed_ids.iter().any(|id| id.is_empty())
                    || confirmed_ids
                        .iter()
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                        != confirmed_ids.len()
                {
                    return Err(invalid("Partial confirmed IDs are empty or duplicate"));
                }
                for observation in pieces {
                    let ordinal = observation.ordinal();
                    let piece = &mut entry.pieces[ordinal as usize];
                    match observation {
                        crate::transport::TransportPieceOutcome::Confirmed {
                            message_id, ..
                        } => {
                            piece.transport_message_id = Some(message_id.clone());
                            piece.outcome = Some(crate::ledger::PieceOutcome::Confirmed {
                                transport_message_id: message_id,
                            });
                        }
                        crate::transport::TransportPieceOutcome::Rejected { code, .. } => {
                            piece.outcome = Some(crate::ledger::PieceOutcome::Rejected { code });
                        }
                        crate::transport::TransportPieceOutcome::Unknown { .. } => {
                            piece.outcome = Some(crate::ledger::PieceOutcome::Unknown);
                        }
                    }
                }
            }
            crate::transport::TransportStatusResult::Rejected { code } => {
                for piece in &mut entry.pieces {
                    if piece.outcome.is_none() {
                        piece.outcome =
                            Some(crate::ledger::PieceOutcome::Rejected { code: code.clone() });
                    }
                }
            }
            crate::transport::TransportStatusResult::Unknown => return Ok(None),
        }
        let mut ledger = self.store.project_ledger()?;
        if let Some(existing) = ledger.outbound.get_mut(action_id) {
            *existing = entry;
        }
        let result = crate::outbound::settle_from_outbound_entry(
            &self.config,
            &mut ledger,
            action_id,
            self.clock.now().as_str(),
        );
        Ok(match result {
            crate::outbound::SendDispatchResult::Terminal { .. } => {
                ledger.outbound_entry(action_id).cloned()
            }
            _ => None,
        })
    }

    /// One consume pass: re-verify the current sealed authority, read the
    /// authoritative committed Blocks, and for every targeted channel send
    /// Action persist the durable `Prepared` record, admit to the bounded
    /// queue under the caller deadline, dispatch, and atomically commit the
    /// durable result + echo markers. Returns one outcome per processed
    /// Action.
    pub fn consume(&mut self, caller_deadline: &str) -> Result<Vec<ConsumerOutcome>, ChannelError> {
        // Fresh authority: re-derive the sealed principal and consult the
        // CURRENT grant in the authoritative Core store BEFORE any durable or
        // transport effect. A revoked grant or a changed generation/lifecycle
        // fence refuses the whole pass with zero effect.
        self.revalidate_current_grant()?;
        // Read the authoritative journal-verified Core snapshot and select the
        // committed targeted Actions — never caller-supplied Blocks. Targeted
        // channel sends that fail parse/validation/preparation (including
        // asset premises) surface here as frozen zero-effect Rejected
        // outcomes; only non-targeted unrelated Actions are skipped.
        let (actions, mut outcomes) = self.committed_targeted_actions()?;
        let mut outcomes_for_admission = Vec::new();
        // PHASE 1: durable admission for each selected Action (insert/
        // replay/conflict + rate + caller-deadline gate). Outcomes that need
        // no transport (replay/conflict/pending/refusal) are emitted here.
        let mut admitted: Vec<CommittedSendAction> = Vec::new();
        for action in &actions {
            match self.admit_one(action, caller_deadline)? {
                AdmitResult::Admitted(admitted_action) => admitted.push(admitted_action),
                AdmitResult::Outcome(outcome) => outcomes_for_admission.push(outcome),
            }
        }
        outcomes.append(&mut outcomes_for_admission);
        if admitted.is_empty() {
            return Ok(outcomes);
        }
        // PHASE 2: dispatch the just-admitted Actions in DURABLE queued_seq
        // order (not snapshot order) — the queue drains FIFO.
        let by_id: std::collections::HashMap<String, &CommittedSendAction> = admitted
            .iter()
            .map(|a| (a.action.action_id.clone(), a))
            .collect();
        let mut ledger = self.store.project_ledger()?;
        for record in self.store.fifo_pending()? {
            if let Some(action) = by_id.get(&record.entry.action_id) {
                outcomes.push(self.dispatch_admitted(&mut ledger, action, &record)?);
            }
        }
        Ok(outcomes)
    }

    /// Select targeted sends only from the one current manifest. Input items
    /// retain manifest order; each Action retains `body.actions` order. The
    /// first configured Delivery occurrence supplies the exact durable
    /// occurrence coordinates. No generic Core Block or event collection is
    /// consulted.
    fn committed_targeted_actions(
        &mut self,
    ) -> Result<(Vec<CommittedSendAction>, Vec<ConsumerOutcome>), ChannelError> {
        let Some(authority) = self.authoritative_manifest()? else {
            return Ok((Vec::new(), Vec::new()));
        };
        let ledger = self.store.project_ledger()?;
        let input_items = authority
            .manifest
            .get("input_items")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ChannelError::new(
                    codes::AUTHORIZATION_FAILED,
                    false,
                    ChannelOutcome::NotApplied,
                    "the current manifest has no input_items array",
                )
            })?;
        let mut actions = Vec::new();
        let mut refused = Vec::new();
        for item in input_items {
            let Some((occurrence_index, occurrence)) = item
                .get("occurrences")
                .and_then(Value::as_array)
                .and_then(|occurrences| {
                    occurrences.iter().enumerate().find(|(_, occurrence)| {
                        occurrence
                            .get("page_id")
                            .and_then(Value::as_str)
                            .is_some_and(|page| authority.configured_pages.contains(page))
                    })
                })
            else {
                continue;
            };
            let Some(actions_in_block) = item
                .get("block")
                .and_then(|block| block.get("body"))
                .and_then(Value::as_object)
                .and_then(|body| body.get("actions"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            for (action_index, action) in actions_in_block.iter().enumerate() {
                // Non-targeted unrelated Actions are skipped exactly as the
                // accepted manifest contract requires: only a
                // `org.dolly.channel.send` may produce a Channel effect or
                // rejection envelope here.
                if action.get("name").and_then(Value::as_str)
                    != Some(crate::config::SEND_ACTION_NAME)
                {
                    continue;
                }
                // A targeted channel send that fails to parse, validate, or
                // prepare (including asset premises) MUST surface as a frozen
                // zero-effect Rejected outcome, never a silent drop. The
                // canonical action_id from the committed Action keys the
                // envelope; a targeted send without a canonical id cannot be
                // keyed to a closed outcome and stays skipped this pass.
                let target_action_id = action.get("action_id").and_then(Value::as_str);
                match CommittedSendAction::from_manifest_input(
                    &authority.manifest,
                    item,
                    occurrence_index,
                    occurrence,
                    action_index,
                    &self.principal,
                    &self.config,
                    &ledger,
                ) {
                    Ok(committed) => actions.push(committed),
                    Err(error) => {
                        if let Some(action_id) = target_action_id {
                            if !action_id.is_empty() {
                                refused.push(ConsumerOutcome::Rejected {
                                    action_id: action_id.to_string(),
                                    error,
                                });
                            }
                        }
                    }
                }
            }
        }
        Ok((actions, refused))
    }

    /// Status-first restart/lost-response recovery of the durable outbound
    /// ledger: never re-dispatches a row that may have reached the
    /// transport and never reports false success. Every `Dispatched` row is
    /// settled by calling
    /// [`ChannelTransport::status`] with the original idempotency key. A
    /// provider `Unknown` is retried status-first until the configured durable
    /// unknown deadline, then freezes the accepted terminal unknown result;
    /// it is never lease-gated or blind-resent.
    /// Returns the number of durable rows still unresolved.
    pub fn reconcile(&mut self) -> Result<usize, ChannelError> {
        let pending = self.store.list_pending_outbound()?;
        let mut remaining = 0;
        for record in pending {
            if record.entry.state != OutboundState::Dispatched {
                remaining += 1;
                continue;
            }
            let request = crate::transport::TransportStatusRequest {
                action_id: record.outbound_key.clone(),
                idempotency_key: record.entry.idempotency_key.clone(),
            };
            self.effect_ts("before_status");
            self.revalidate_durable_record(&record)?;
            // Once a send may have occurred (the row is durably Dispatched),
            // status query and terminal settlement MUST resolve the observed
            // effect and NEVER block on Asset lease validity: status-first
            // recovery does not reread or resend media and never leaves a
            // row Dispatched indefinitely over a lease.
            let status = self.transport.status(&request);
            self.effect_ts("after_status");
            self.revalidate_durable_record(&record)?;
            let stale_unknown = matches!(status, crate::transport::TransportStatusResult::Unknown)
                && record
                    .entry
                    .dispatched_at
                    .as_deref()
                    .is_some_and(|dispatched_at| {
                        crate::clock::timestamp_total_micros(self.clock.now().as_str())
                            - crate::clock::timestamp_total_micros(dispatched_at)
                            >= self.config.outbound_limits.unknown_after_seconds as i64 * 1_000_000
                    });
            let entry = if stale_unknown {
                let mut ledger = self.store.project_ledger()?;
                crate::outbound::settle_recovered_unknown(
                    &self.config,
                    &mut ledger,
                    &record.outbound_key,
                    self.clock.now().as_str(),
                );
                ledger.outbound_entry(&record.outbound_key).cloned()
            } else {
                self.settle_status(&record, status)?
            };
            let Some(entry) = entry else {
                remaining += 1;
                continue;
            };
            let terminal_record = self.build_terminal_record_from_entry(&record, &entry);
            self.effect_ts("before_terminal_commit");
            self.revalidate_durable_record(&record)?;
            self.store.commit_outbound_terminal(&terminal_record)?;
            self.gate.wake_all();
        }
        Ok(remaining)
    }

    /// Build a terminal record from a prior durable record and a settled
    /// entry, preserving the authority and committed Action bytes.
    fn build_terminal_record_from_entry(
        &self,
        prior: &DurableOutboundRecord,
        entry: &crate::ledger::OutboundEntry,
    ) -> DurableOutboundRecord {
        let mut record = prior.clone();
        record.entry = entry.clone();
        record
    }

    /// Build the durable `Prepared` record for one verified committed Action.
    fn build_prepared_record(&self, committed: &CommittedSendAction) -> DurableOutboundRecord {
        let entry = build_prepared_entry(
            &self.config,
            &*self.clock,
            &committed.action,
            &committed.session_id,
            committed.pieces.clone(),
            true,
        );
        DurableOutboundRecord {
            schema: crate::store::OUTBOUND_RECORD_SCHEMA.to_string(),
            version: 1,
            outbound_key: committed.action.action_id.clone(),
            digest: committed.operation_digest.clone(),
            action_jcs: committed.action_jcs.clone(),
            activation_id: committed.activation_id.clone(),
            manifest_digest: committed.manifest_digest.clone(),
            occurrence_index: committed.occurrence_index,
            page_id: committed.page_id.clone(),
            page_seq: committed.page_seq,
            commit_seq: committed.commit_seq,
            action_index: committed.action_index,
            block_id: committed.block_id.clone(),
            target_module_id: committed.action.target_module_id.clone(),
            owner: self.principal.owner().to_string(),
            extension_id: self.principal.extension_id().to_string(),
            module_id: self.principal.module_id().to_string(),
            instance_id: self.principal.instance_id().to_string(),
            generation: self.principal.generation() as i64,
            revision: self.principal.revision(),
            graph_revision: self.principal.graph_revision(),
            graph_digest: self.principal.graph_digest().to_string(),
            config_revision: self.config.revision,
            account: self.principal.account().to_string(),
            entry,
        }
    }

    /// Phase 1: durable admission for one committed Action (insert/prepare +
    /// replay/conflict + rate + caller-deadline gate). Returns the admitted
    /// Action for FIFO dispatch, or a final/refused outcome with no transport.
    fn admit_one(
        &mut self,
        committed: &CommittedSendAction,
        caller_deadline: &str,
    ) -> Result<AdmitResult, ChannelError> {
        // 1. Atomic insert/replay/conflict: the exact action key + operation
        //    digest is durably persisted as `Prepared` in one SQLite
        //    transaction (INSERT ... ON CONFLICT DO NOTHING). A fresh key
        //    inserts; an existing key with the same digest replays (terminal
        //    returns the frozen result with zero re-dispatch, non-terminal is
        //    returned unchanged); a different digest conflicts before enqueue
        //    and changes nothing. The durable idempotency key is always
        //    present (item 3) and the transport is status-capable (item 2).
        let prepared = self.build_prepared_record(committed);
        match self.store.insert_prepared_or_replay(&prepared) {
            Ok(OutboundPreparedOutcome::ReplayTerminal { state, result_jcs }) => {
                return Ok(AdmitResult::Outcome(ConsumerOutcome::Terminal {
                    action_id: committed.action.action_id.clone(),
                    state,
                    result_jcs,
                }));
            }
            Ok(OutboundPreparedOutcome::Prepared | OutboundPreparedOutcome::PreparedExisting) => {}
            Err(error) if error.code == codes::OPERATION_CONFLICT => {
                return Ok(AdmitResult::Outcome(ConsumerOutcome::Rejected {
                    action_id: committed.action.action_id.clone(),
                    error,
                }));
            }
            Err(error) => return Err(error),
        }
        // Fresh execution authority immediately after the durable prepare.
        self.revalidate_committed_action(committed)?;
        // 2a. Surviving durable row: only a `Prepared`/`Queued` row may be
        //    dispatched. A `Dispatched`/terminal row is owned by status-first
        //    recovery and must never re-enter the queue or the transport.
        let durable = self
            .store
            .find_outbound(&committed.action.action_id)?
            .expect("durable outbound row");
        if !durable.entry.state.is_dispatchable() {
            return Ok(AdmitResult::Outcome(ConsumerOutcome::Pending {
                action_id: committed.action.action_id.clone(),
            }));
        }
        // Ticket, deadline, rate bucket, combined occupancy, and queue grant
        // are durable and serialized by one SQLite admission transaction.
        if durable.entry.state == OutboundState::Prepared {
            if let Err(error) = self.gate.admit(
                &mut self.store,
                &committed.session_id,
                &committed.action.action_id,
                committed.pieces.len() as u64,
                crate::clock::timestamp_total_micros(caller_deadline),
                &*self.clock,
            ) {
                return Ok(AdmitResult::Outcome(ConsumerOutcome::Rejected {
                    action_id: committed.action.action_id.clone(),
                    error,
                }));
            }
        }
        // Fresh execution authority after the queue wait. Asset payload
        // preparation happens only after durable admission and before the
        // dispatch claim, so any preparation failure can be frozen durably as
        // a zero-effect terminal rejection.
        self.effect_ts("after_queue_wait");
        self.revalidate_committed_action(committed)?;
        if crate::clock::timestamp_total_micros(self.clock.now().as_str())
            >= crate::clock::timestamp_total_micros(caller_deadline)
        {
            return Ok(AdmitResult::Outcome(ConsumerOutcome::Rejected {
                action_id: committed.action.action_id.clone(),
                error: crate::error::ChannelError::new(
                    codes::RATE_LIMITED,
                    true,
                    ChannelOutcome::NotApplied,
                    "caller deadline expired after durable admission",
                ),
            }));
        }
        Ok(AdmitResult::Admitted(committed.clone()))
    }

    /// Phase 2: complete Asset payload preparation, persist its proof, then
    /// claim dispatch and send the already-composed request. No Asset service
    /// or read call exists after the claim.
    fn dispatch_admitted(
        &mut self,
        ledger: &mut ChannelLedger,
        committed: &CommittedSendAction,
        durable: &DurableOutboundRecord,
    ) -> Result<ConsumerOutcome, ChannelError> {
        self.revalidate_committed_action(committed)?;
        self.effect_ts("before_asset_prepare");
        let prepared = match prepare_transport_request(
            &self.config,
            &mut *self.asset_preparation,
            &committed.action.action_id,
            durable.entry.idempotency_key.clone(),
            &committed.session_id,
            &durable.entry.pieces,
        ) {
            Ok(prepared) => prepared,
            Err(error) => {
                ledger
                    .outbound
                    .entry(committed.action.action_id.clone())
                    .or_insert_with(|| durable.entry.clone());
                let _ = settle_pre_effect_rejection(
                    ledger,
                    &committed.action.action_id,
                    self.clock.now().as_str(),
                    error,
                );
                let entry = ledger
                    .outbound_entry(&committed.action.action_id)
                    .cloned()
                    .expect("pre-effect rejection entry");
                let mut rejection = durable.clone();
                rejection.entry = entry.clone();
                return match self
                    .store
                    .replace_queued_before_dispatch(durable, &rejection)?
                {
                    QueuedRecordUpdate::Updated => {
                        self.gate.wake_all();
                        Ok(ConsumerOutcome::Terminal {
                            action_id: committed.action.action_id.clone(),
                            state: entry.state,
                            result_jcs: entry.result_jcs.unwrap_or_default(),
                        })
                    }
                    QueuedRecordUpdate::AlreadyTerminal { state, result_jcs } => {
                        Ok(ConsumerOutcome::Terminal {
                            action_id: committed.action.action_id.clone(),
                            state,
                            result_jcs: result_jcs.unwrap_or_default(),
                        })
                    }
                    QueuedRecordUpdate::AlreadyDispatched | QueuedRecordUpdate::LostRace => {
                        Ok(ConsumerOutcome::Pending {
                            action_id: committed.action.action_id.clone(),
                        })
                    }
                };
            }
        };
        self.effect_ts("after_asset_prepare");
        self.revalidate_committed_action(committed)?;

        // Persist only the exact proof/status identity; `prepared.request`
        // retains the ephemeral bytes in memory.
        let mut prepared_record = durable.clone();
        prepared_record.entry.pieces = prepared.durable_pieces.clone();
        match self
            .store
            .replace_queued_before_dispatch(durable, &prepared_record)?
        {
            QueuedRecordUpdate::Updated => {}
            QueuedRecordUpdate::AlreadyTerminal { state, result_jcs } => {
                return Ok(ConsumerOutcome::Terminal {
                    action_id: committed.action.action_id.clone(),
                    state,
                    result_jcs: result_jcs.unwrap_or_default(),
                });
            }
            QueuedRecordUpdate::AlreadyDispatched | QueuedRecordUpdate::LostRace => {
                return Ok(ConsumerOutcome::Pending {
                    action_id: committed.action.action_id.clone(),
                });
            }
        }
        ledger.outbound.insert(
            committed.action.action_id.clone(),
            prepared_record.entry.clone(),
        );

        let claim_time = self.clock.now().as_str().to_string();
        match self
            .store
            .claim_dispatch(&committed.action.action_id, &claim_time)
        {
            Ok(DispatchClaim::Won(won_record)) => {
                ledger
                    .outbound
                    .insert(committed.action.action_id.clone(), won_record.entry.clone());
                // Asset payload acquisition is complete. The accepted
                // authority fence runs once after the claim; any refusal is
                // frozen as zero-effect terminal. No later step reads Asset.
                self.effect_ts("after_dispatch_cas");
                if let Err(error) = self.revalidate_committed_action(committed) {
                    let _ = settle_pre_effect_rejection(
                        ledger,
                        &committed.action.action_id,
                        self.clock.now().as_str(),
                        error,
                    );
                    let entry = ledger
                        .outbound_entry(&committed.action.action_id)
                        .cloned()
                        .expect("claimed authority rejection entry");
                    let mut terminal_record = won_record.clone();
                    terminal_record.entry = entry.clone();
                    self.store.commit_outbound_terminal(&terminal_record)?;
                    self.gate.wake_all();
                    return Ok(ConsumerOutcome::Terminal {
                        action_id: committed.action.action_id.clone(),
                        state: entry.state,
                        result_jcs: entry.result_jcs.unwrap_or_default(),
                    });
                }
                let now_ms = (crate::clock::timestamp_total_micros(self.clock.now().as_str()).max(0)
                    as u64)
                    / 1_000;
                if let Err(error) = validate_prepared_transport_for_send(
                    &self.config,
                    &prepared.request,
                    &won_record.entry.pieces,
                    now_ms,
                ) {
                    let _ = settle_pre_effect_rejection(
                        ledger,
                        &committed.action.action_id,
                        self.clock.now().as_str(),
                        error,
                    );
                    let entry = ledger
                        .outbound_entry(&committed.action.action_id)
                        .cloned()
                        .expect("claimed pre-effect rejection entry");
                    let mut terminal_record = won_record;
                    terminal_record.entry = entry.clone();
                    self.store.commit_outbound_terminal(&terminal_record)?;
                    self.gate.wake_all();
                    return Ok(ConsumerOutcome::Terminal {
                        action_id: committed.action.action_id.clone(),
                        state: entry.state,
                        result_jcs: entry.result_jcs.unwrap_or_default(),
                    });
                }

                let result = transport_and_settle(
                    &self.config,
                    ledger,
                    &mut *self.transport,
                    &prepared.request,
                    &claim_time,
                );
                match result {
                    SendDispatchResult::Terminal { state, result } => {
                        let entry = ledger
                            .outbound_entry(&committed.action.action_id)
                            .cloned()
                            .expect("settled outbound row");
                        let mut record = won_record;
                        record.entry = entry;
                        self.effect_ts("before_terminal_commit");
                        self.revalidate_committed_action(committed)?;
                        self.store.commit_outbound_terminal(&record)?;
                        self.gate.wake_all();
                        let result_jcs = dolly_canonical_json::canonicalize(&result)
                            .map(|(bytes, _)| String::from_utf8(bytes.as_bytes().to_vec()))
                            .unwrap_or(Ok("canonicalize-failed".to_string()))
                            .unwrap_or_else(|_| "canonicalize-failed".to_string());
                        Ok(ConsumerOutcome::Terminal {
                            action_id: committed.action.action_id.clone(),
                            state,
                            result_jcs,
                        })
                    }
                    SendDispatchResult::DispatchedPending => Ok(ConsumerOutcome::Pending {
                        action_id: committed.action.action_id.clone(),
                    }),
                    SendDispatchResult::Rejected(error) => Err(ChannelError::new(
                        error.code,
                        error.retryable,
                        error.outcome,
                        format!("outbound dispatch failed internally: {}", error.message),
                    )),
                }
            }
            Ok(DispatchClaim::AlreadyDispatched) | Ok(DispatchClaim::LostRace) => {
                Ok(ConsumerOutcome::Pending {
                    action_id: committed.action.action_id.clone(),
                })
            }
            Ok(DispatchClaim::AlreadyTerminal { state, result_jcs }) => {
                Ok(ConsumerOutcome::Terminal {
                    action_id: committed.action.action_id.clone(),
                    state,
                    result_jcs: result_jcs.unwrap_or_default(),
                })
            }
            Err(error) => {
                self.gate.wake_all();
                Err(error)
            }
        }
    }
}

/// The configured input Pages for `module_id`: the frozen graph document's
/// `input_pages` map entry for the module (interpretation authority only —
/// it validates which Page delivered a manifest-selected Block, it never
/// mints identity). The operable graph wrapper is `{digest, graph, revision}`;
/// the installed document is under `graph`.
fn configured_input_pages(
    snapshot: &CoreSnapshot,
    module_id: &str,
) -> std::collections::BTreeSet<String> {
    let document = snapshot.graph.get("graph").unwrap_or(&snapshot.graph);
    let mut out = std::collections::BTreeSet::new();
    if let Some(map) = document.get("input_pages").and_then(Value::as_object) {
        if let Some(pages) = map.get(module_id).and_then(Value::as_array) {
            for page in pages {
                if let Some(p) = page.as_str() {
                    out.insert(p.to_string());
                }
            }
        }
    }
    out
}
