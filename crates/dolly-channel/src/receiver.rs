//! Durable Channel inbound receiver (G4-C wiring) — the single public entry.
//!
//! The receiver is the only public submission path. Direction is preserved:
//!
//! ```text
//! authenticated transport event (sealed under the Host authority/grant)
//!   -> recompute/compare the full bound principal (owner/Extension/module/
//!      instance/generation/incarnation/graph revision+digest/config revision/
//!      account) against the current sealed HostConnectionAuthority +
//!      HostCapabilityGrant (before any replay/ack)
//!   -> durable prepared Channel intent (module-scoped SQLite, BEFORE any
//!      Host submit or Core effect)
//!   -> sealed B Host ingress premise
//!   -> Core exactly once
//!   -> atomic terminal intent (same Channel DB transaction)
//! ```
//!
//! A crash or failed final transaction after a Host commit leaves the durable
//! row `prepared`; `reconcile()` (no event redelivery) reopens that row, calls
//! Host `status` first with the current sealed authority, and restores the
//! terminal state exactly once.

use dolly_core_domain::Timestamp;
use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority, HostIngress};

use crate::clock::Clock;
use crate::config::ChannelConfig;
use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::attachment::{
    AttachmentImportRequest, AttachmentImportStatus, AttachmentRecord, AttachmentState,
    InboundAttachment, InboundAssetImport,
};
use crate::host_adapter::{HostIngressCoreAdapter, channel_intent_digest, payload_digest_of};
use crate::ids;
use crate::ingress::{
    CoreIngress, CoreIngressError, IngressOutcome, IngressSubmitReceipt, IngressSubmitRequest,
    InboundEvent, process_event_with_assets,
};
use crate::intent::IntentState;
use crate::ledger::{ChannelLedger, InboundState};
use crate::principal::ChannelPrincipal;
use crate::store::SqliteChannelStore;

/// The raw, transport-supplied content of one authenticated Channel event.
/// Carries only message content — never an account, owner, fence, or target
/// claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelEventContent {
    pub channel_id: String,
    pub transport: String,
    pub external_conversation_id: String,
    pub external_message_id: String,
    pub sender_class: String,
    pub sender_id: String,
    pub text: String,
    pub received_at: Timestamp,
    pub event_kind: crate::ledger::EventKind,
    pub references_external_message_id: Option<String>,
}

/// An opaque, already-authenticated Channel transport event.
///
/// Binds the COMPLETE current authority/grant facts — owner, Extension,
/// module, instance (security domain / worker epoch), Extension generation,
/// Host incarnation revision, graph revision + digest, and the derived
/// account — needed to prevent reuse across generation/incarnation/lifecycle/
/// config/graph. The account hash is NOT a substitute for these fences: every
/// fact is bound explicitly and compared explicitly. Constructed only through
/// [`AuthenticatedChannelEvent::new`], which requires the current sealed Host
/// authority and capability grant plus authenticated transport data; no public
/// deserializer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedChannelEvent {
    bound_owner: String,
    bound_extension_id: String,
    bound_module_id: String,
    bound_instance_id: String,
    bound_generation: u64,
    bound_revision: i64,
    bound_graph_revision: i64,
    bound_graph_digest: String,
    bound_config_revision: i64,
    bound_account: String,
    content: ChannelEventContent,
    /// Ordered typed provider attachments (empty for v1 text events).
    attachments: Vec<InboundAttachment>,
}

impl AuthenticatedChannelEvent {
    /// Seal one authenticated transport event under the opaque current Host
    /// authority and capability grant plus the current config revision. Every
    /// authoritative fact is derived from the sealed principal; the caller
    /// supplies message content only.
    pub fn new(
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
        config_revision: i64,
        content: ChannelEventContent,
    ) -> Result<Self, ChannelError> {
        Self::new_with_attachments(authority, grant, config_revision, content, Vec::new())
    }

    /// Seal one authenticated multimodal transport event with its ordered
    /// typed provider attachments. Attachments are explicit premises only:
    /// the Channel never treats them as Asset authority and never reads a
    /// path or bytes.
    pub fn new_with_attachments(
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
        config_revision: i64,
        content: ChannelEventContent,
        attachments: Vec<InboundAttachment>,
    ) -> Result<Self, ChannelError> {
        let principal = ChannelPrincipal::from_authority_grant(authority, grant)?;
        Ok(Self {
            bound_owner: principal.owner().to_string(),
            bound_extension_id: principal.extension_id().to_string(),
            bound_module_id: principal.module_id().to_string(),
            bound_instance_id: principal.instance_id().to_string(),
            bound_generation: principal.generation(),
            bound_revision: principal.revision(),
            bound_graph_revision: principal.graph_revision(),
            bound_graph_digest: principal.graph_digest().to_string(),
            bound_config_revision: config_revision,
            bound_account: principal.account().to_string(),
            content,
            attachments,
        })
    }

    /// Whether every bound fact matches the current principal and config
    /// revision. Each fence is compared explicitly.
    fn matches_current(&self, principal: &ChannelPrincipal, config_revision: i64) -> bool {
        self.bound_owner == principal.owner()
            && self.bound_extension_id == principal.extension_id()
            && self.bound_module_id == principal.module_id()
            && self.bound_instance_id == principal.instance_id()
            && self.bound_generation == principal.generation()
            && self.bound_revision == principal.revision()
            && self.bound_graph_revision == principal.graph_revision()
            && self.bound_graph_digest == principal.graph_digest()
            && self.bound_config_revision == config_revision
            && self.bound_account == principal.account()
    }

    fn into_inbound_event(self, account: String) -> InboundEvent {
        InboundEvent {
            channel_id: self.content.channel_id,
            transport: self.content.transport,
            account,
            external_conversation_id: self.content.external_conversation_id,
            external_message_id: self.content.external_message_id,
            sender_class: self.content.sender_class,
            sender_id: self.content.sender_id,
            text: self.content.text,
            received_at: self.content.received_at,
            event_kind: self.content.event_kind,
            references_external_message_id: self.content.references_external_message_id,
            attachments: self.attachments,
        }
    }
}

/// The durable Channel inbound facade over one module-scoped store and one
/// `HostIngress` implementation. The only public submission path.
pub struct InboundReceiver<'conn, 'principal, H: HostIngress> {
    config: ChannelConfig,
    clock: Box<dyn Clock>,
    store: SqliteChannelStore<'conn>,
    host: H,
    authority: &'principal HostConnectionAuthority,
    grant: &'principal HostCapabilityGrant,
    principal: ChannelPrincipal,
    /// The single injected inbound Asset import seam (sole integrator); the
    /// default [`crate::attachment::DenyAttachments`] keeps the accepted
    /// text-only profile fail-closed.
    assets: Box<dyn InboundAssetImport>,
}

impl<'conn, 'principal, H: HostIngress> InboundReceiver<'conn, 'principal, H> {
    /// Bind the receiver to the opaque current Host authority and capability
    /// grant, and open the module-scoped store under the same principal. The
    /// free configuration is bound to the sealed principal here: the Extension
    /// and Module MUST equal the granted ones, and the effective transport
    /// account is REPLACED by the authority-derived account. Cross-principal
    /// store reuse fails closed inside `SqliteChannelStore::new`.
    pub fn new(
        config: ChannelConfig,
        clock: Box<dyn Clock>,
        connection: &'conn mut rusqlite::Connection,
        host: H,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
    ) -> Result<Self, ChannelError> {
        let principal = ChannelPrincipal::from_authority_grant(authority, grant)?;
        if config.extension_id != principal.extension_id() {
            return Err(ChannelError::new(codes::AUTHENTICATION_FAILED, false, ChannelOutcome::NotApplied, "channel config Extension does not match the granted Channel Extension"));
        }
        if config.module_id != principal.module_id() {
            return Err(ChannelError::new(codes::AUTHENTICATION_FAILED, false, ChannelOutcome::NotApplied, "channel config Module does not match the granted Module"));
        }
        let mut config = config;
        config.transport_account = principal.account().to_string();
        let store = SqliteChannelStore::new(connection, &principal, config.revision)?;
        Ok(Self { config, clock, store, host, authority, grant, principal, assets: Box::new(crate::attachment::DenyAttachments) })
    }

    /// Bind the receiver with the single injected inbound Asset import seam
    /// (sole integrator: the Host/Runtime). The default [`InboundReceiver::new`]
    /// constructor stays the accepted text-only path and refuses attachments
    /// fail-closed; this explicit constructor is the only production seam that
    /// enables ordered multimodal attachments.
    pub fn with_asset_import(
        config: ChannelConfig,
        clock: Box<dyn Clock>,
        connection: &'conn mut rusqlite::Connection,
        host: H,
        assets: Box<dyn InboundAssetImport>,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
    ) -> Result<Self, ChannelError> {
        let principal = ChannelPrincipal::from_authority_grant(authority, grant)?;
        if config.extension_id != principal.extension_id() {
            return Err(ChannelError::new(codes::AUTHENTICATION_FAILED, false, ChannelOutcome::NotApplied, "channel config Extension does not match the granted Channel Extension"));
        }
        if config.module_id != principal.module_id() {
            return Err(ChannelError::new(codes::AUTHENTICATION_FAILED, false, ChannelOutcome::NotApplied, "channel config Module does not match the granted Module"));
        }
        let mut config = config;
        config.transport_account = principal.account().to_string();
        let store = SqliteChannelStore::new(connection, &principal, config.revision)?;
        Ok(Self { config, clock, store, host, authority, grant, principal, assets })
    }

    /// The current in-memory Channel ledger projection (rebuilt from the
    /// durable intents + echo markers, the single source of truth).
    pub fn ledger(&mut self) -> Result<crate::ledger::ChannelLedger, ChannelError> {
        self.store.project_ledger()
    }

    /// Test-support only: build the receiver over a pre-opened store so tests
    /// can inject store failpoints while still enforcing store/principal
    /// equality. Not available in the default production build.
    #[cfg(feature = "test-support")]
    pub fn new_with_store(
        config: ChannelConfig,
        clock: Box<dyn Clock>,
        store: SqliteChannelStore<'conn>,
        host: H,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
    ) -> Result<Self, ChannelError> {
        let principal = ChannelPrincipal::from_authority_grant(authority, grant)?;
        if config.extension_id != principal.extension_id() {
            return Err(ChannelError::new(codes::AUTHENTICATION_FAILED, false, ChannelOutcome::NotApplied, "channel config Extension does not match the granted Channel Extension"));
        }
        if config.module_id != principal.module_id() {
            return Err(ChannelError::new(codes::AUTHENTICATION_FAILED, false, ChannelOutcome::NotApplied, "channel config Module does not match the granted Module"));
        }
        let mut config = config;
        config.transport_account = principal.account().to_string();
        store.verify_owner_against(&principal, config.revision)?;
        Ok(Self {
            config,
            clock,
            store,
            host,
            authority,
            grant,
            principal,
            assets: Box::new(crate::attachment::DenyAttachments),
        })
    }

    /// Test-support only: multimodal variant with the injected inbound Asset
    /// import seam over a pre-opened store.
    #[cfg(feature = "test-support")]
    pub fn with_asset_import_on_store(
        config: ChannelConfig,
        clock: Box<dyn Clock>,
        store: SqliteChannelStore<'conn>,
        host: H,
        assets: Box<dyn InboundAssetImport>,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
    ) -> Result<Self, ChannelError> {
        let principal = ChannelPrincipal::from_authority_grant(authority, grant)?;
        if config.extension_id != principal.extension_id() {
            return Err(ChannelError::new(codes::AUTHENTICATION_FAILED, false, ChannelOutcome::NotApplied, "channel config Extension does not match the granted Channel Extension"));
        }
        if config.module_id != principal.module_id() {
            return Err(ChannelError::new(codes::AUTHENTICATION_FAILED, false, ChannelOutcome::NotApplied, "channel config Module does not match the granted Module"));
        }
        let mut config = config;
        config.transport_account = principal.account().to_string();
        store.verify_owner_against(&principal, config.revision)?;
        Ok(Self {
            config,
            clock,
            store,
            host,
            authority,
            grant,
            principal,
            assets,
        })
    }

    /// Process one sealed, already-authenticated event.
    pub fn ingest_event(&mut self, event: &AuthenticatedChannelEvent) -> IngressOutcome {
        // 1. Recompute/compare the full bound principal against the CURRENT
        //    sealed authority/grant + config revision before any replay/ack.
        let principal = match ChannelPrincipal::from_authority_grant(self.authority, self.grant) {
            Ok(p) => p,
            Err(e) => return IngressOutcome::RejectedBeforeMutation { error: e },
        };
        if !event.matches_current(&principal, self.config.revision) {
            return IngressOutcome::RejectedBeforeMutation {
                error: ChannelError::new(codes::AUTHENTICATION_FAILED, false, ChannelOutcome::NotApplied, "the event is bound to a different authenticated principal, generation, incarnation, graph, or config"),
            };
        }
        // Enforce store/principal equality on every use.
        if principal != self.principal {
            return IngressOutcome::RejectedBeforeMutation {
                error: ChannelError::new(codes::AUTHENTICATION_FAILED, false, ChannelOutcome::NotApplied, "the store is bound to a different principal"),
            };
        }

        let inbound = event.clone().into_inbound_event(principal.account().to_string());
        let intent_key = ids::inbound_ingress_key(principal.account(), &inbound.external_message_id);

        // 2. Pre-replay conflict and prior-rejection binding against the
        //    durable intent: the Channel-local digest includes the ordered
        //    target Pages, so a same-key replay whose targets/order changed
        //    conflicts BEFORE any Core path is reached. The accepted intent
        //    is retained for the full Host-mapping validation on replay.
        let accepted_pre_intent: Option<crate::intent::ChannelIntent> = match self.store.find_intent(&intent_key) {
            Ok(Some(intent)) => {
                if intent.state == IntentState::Rejected {
                    let code = intent.rejected_code.clone().unwrap_or_else(|| codes::INTERNAL.to_string());
                    return IngressOutcome::RejectedBeforeMutation {
                        error: ChannelError::new(code, false, ChannelOutcome::NotApplied, "the event key was already durably rejected"),
                    };
                }
                if intent.state == IntentState::Accepted {
                    let current_payload_digest = payload_digest_of(&intent.request_jcs);
                    let current_digest = channel_intent_digest(
                        principal.account(), principal.extension_id(), principal.module_id(), principal.instance_id(),
                        principal.generation(), principal.revision(), principal.graph_revision(), principal.graph_digest(),
                        self.config.revision, &intent.external_event_id, intent.kind,
                        intent.references_external_event_id.as_deref(), &self.config.target_page_ids,
                        &current_payload_digest);
                    if current_digest != intent.digest {
                        return IngressOutcome::RejectedBeforeMutation {
                            error: ChannelError::new(codes::OPERATION_CONFLICT, false, ChannelOutcome::NotApplied, "the same event key now carries different pages/content/relation"),
                        };
                    }
                    Some(intent)
                } else {
                    None
                }
            }
            Ok(None) => None,
            Err(e) => return IngressOutcome::RejectedBeforeMutation { error: e },
        };

        // 3. The accepted pipeline runs with a fresh adapter over the owned
        //    store. Suppress a durable sent-transport echo before Host/Core
        //    via the projection seeded with echo markers.
        let (outcome, ledger) = {
            let ledger = match self.store.project_ledger() {
                Ok(projected) => projected,
                Err(_) => {
                    // Corrupt Channel state (forged/noncanonical echo row or
                    // intent) fails closed: no Host/Core effect, no success.
                    return IngressOutcome::SubmissionPending;
                }
            };
            let mut ledger = ledger;
            let mut adapter = HostIngressCoreAdapter::new(
                &mut self.host,
                self.authority,
                self.grant,
                &mut self.store,
                self.config.revision,
            );
            let outcome = process_event_with_assets(
                &self.config,
                &*self.clock,
                &mut ledger,
                &mut adapter,
                &mut *self.assets,
                &inbound,
            );
            (outcome, ledger)
        };

        // 4. A replay must still revalidate the CURRENT authority/grant and
        //    status, and the returned Host mapping goes through the FULL
        //    validate_host_mapping before the cached success is acknowledged.
        let outcome = match outcome {
            IngressOutcome::IdempotentReplay { block_id } => match accepted_pre_intent {
                Some(accepted_intent) => {
                    let mut adapter = HostIngressCoreAdapter::new(
                        &mut self.host,
                        self.authority,
                        self.grant,
                        &mut self.store,
                        self.config.revision,
                    );
                    match adapter.status_mapping_for_event(&inbound.external_message_id) {
                        Ok(Some(mapping)) => {
                            match crate::host_adapter::validate_host_mapping(&accepted_intent, &mapping) {
                                Ok(()) if mapping.block_id == block_id => IngressOutcome::IdempotentReplay { block_id },
                                Ok(()) => IngressOutcome::RejectedBeforeMutation {
                                    error: ChannelError::new(codes::LEDGER_CORRUPT, false, ChannelOutcome::NotApplied, "replayed block identity does not match the durable Host mapping"),
                                },
                                Err(validation_error) => IngressOutcome::RejectedBeforeMutation { error: validation_error },
                            }
                        }
                        Ok(None) => IngressOutcome::RejectedBeforeMutation {
                            error: ChannelError::new(codes::LEDGER_CORRUPT, false, ChannelOutcome::NotApplied, "the accepted Channel row has no durable Host mapping"),
                        },
                        Err(CoreIngressError::Rejected { code }) => IngressOutcome::RejectedBeforeMutation {
                            error: ChannelError::new(code, false, ChannelOutcome::NotApplied, "the current authority/grant revalidation rejected the replay"),
                        },
                        Err(_) => IngressOutcome::RejectedBeforeMutation {
                            error: ChannelError::new(codes::INTERNAL, false, ChannelOutcome::NotApplied, "the current authority/grant revalidation outcome is unknown"),
                        },
                    }
                }
                None => IngressOutcome::RejectedBeforeMutation {
                    error: ChannelError::new(codes::INTERNAL, false, ChannelOutcome::NotApplied, "accepted intent row vanished before replay validation"),
                },
            },
            other => other,
        };
        // WP-013B assets-pending durability: persist the `prepared` intent
        // with its ordered attachment import records BEFORE returning, so a
        // restart resumes the imports through status-first recovery (never a
        // blind re-import and never a fabricated reference).
        if matches!(outcome, IngressOutcome::SubmissionPending)
            && ledger
                .inbound_entry(&inbound.account, &inbound.external_message_id)
                .map(|entry| entry.state == InboundState::AssetsPending)
                .unwrap_or(false)
        {
            if let Err(error) = self.persist_attachment_prepared_intent(&principal, &inbound, &ledger)
            {
                return IngressOutcome::RejectedBeforeMutation { error };
            }
        }
        outcome
    }

    /// Durably persist one `assets_pending` event as a `prepared` intent
    /// carrying its attachment import records, so recovery (never a blind
    /// re-import) can resume through the injected seam's status.
    fn persist_attachment_prepared_intent(
        &mut self,
        principal: &ChannelPrincipal,
        inbound: &InboundEvent,
        ledger: &ChannelLedger,
    ) -> Result<(), ChannelError> {
        let entry = ledger
            .inbound_entry(&inbound.account, &inbound.external_message_id)
            .ok_or_else(|| {
                ChannelError::new(
                    codes::INTERNAL,
                    false,
                    ChannelOutcome::NotApplied,
                    "assets_pending ledger row vanished before durable persist",
                )
            })?;
        let session_id = ledger
            .session(&inbound.account, &inbound.external_conversation_id)
            .cloned()
            .unwrap_or_else(|| {
                ids::dolly_session_id(&inbound.account, &inbound.external_conversation_id)
            });
        let normalized = crate::ingress::normalize_text(&inbound.text).map_err(|error| {
            ChannelError::new(
                error.code,
                false,
                ChannelOutcome::NotApplied,
                format!("durable persist normalization failed: {}", error.message),
            )
        })?;
        let draft = crate::ingress::build_draft(&inbound, &session_id, &normalized)?;
        if entry.request_jcs.is_empty() {
            return Err(ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::NotApplied,
                "assets_pending row has no placeholder draft",
            ));
        }
        let request = IngressSubmitRequest {
            operation_id: ids::operation_id(&inbound.account, &inbound.external_message_id, 1),
            module_id: self.config.module_id.clone(),
            idempotency_key: entry.ingress_key.clone(),
            draft: draft.clone(),
            target_page_ids: self.config.target_page_ids.clone(),
            deadline: crate::clock::timestamp_plus_seconds(
                self.clock.now().as_str(),
                self.config.operation_deadline_seconds as i64,
            ),
        };
        let facts = crate::host_adapter::channel_facts_from_draft(&request.draft).map_err(|error| {
            ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::NotApplied,
                format!("attachment intent facts unavailable: {error:?}"),
            )
        })?;
        let mut intent = crate::host_adapter::prepare_intent(
            principal,
            self.config.revision,
            &request,
            &facts,
        )?;
        intent.attachments = entry.attachments.clone();
        intent.request_jcs = entry.request_jcs.clone();
        intent.payload_digest = crate::host_adapter::payload_digest_of(&intent.request_jcs);
        self.store.write_prepared(&intent)
    }

    /// Reconcile every durable `prepared` intent through `status` first, with
    /// NO event redelivery. Restores the terminal ledger/state exactly once.
    /// Returns the number of intents left unresolved.
    /// Reconcile every durable `prepared` intent through `status` first, with
    /// NO event redelivery. Restores the terminal ledger/state exactly once
    /// (attachment intents resume status-first through the injected Asset
    /// import seam, never a blind re-import). Returns the number of intents
    /// left unresolved.
    pub fn reconcile(&mut self) -> Result<usize, ChannelError> {
        let pending_keys: Vec<String> = self.store.list_pending()?.into_iter().map(|i| i.intent_key).collect();
        let mut remaining = 0;
        for intent_key in pending_keys {
            let intent = match self.store.find_intent(&intent_key)? {
                Some(intent) => intent,
                None => continue,
            };
            // WP-013B attachment recovery: a `prepared` intent carrying
            // attachment import records resumes through the injected seam's
            // STATUS (never a blind re-import). A refusal is durable and
            // explicit; when every required asset is AVAILABLE the final
            // Asset-bearing draft is submitted and committed exactly once.
            if !intent.attachments.is_empty() {
                let resolved = self.resume_attachment_intent(intent)?;
                if !resolved {
                    remaining += 1;
                }
                continue;
            }
            let terminal = {
                let mut adapter = HostIngressCoreAdapter::new(
                    &mut self.host,
                    self.authority,
                    self.grant,
                    &mut self.store,
                    self.config.revision,
                );
                match adapter.status_mapping_for_event(&intent.external_event_id) {
                    Ok(Some(mapping)) => {
                        // Validate the Host mapping against the exact prepared
                        // intent BEFORE terminal commit; a same-key mapping for
                        // different content/targets/relation is a conflict that
                        // must never be adopted as success (the row stays
                        // Prepared and reconcile fails closed).
                        if crate::host_adapter::validate_host_mapping(&intent, &mapping).is_err() {
                            return Err(ChannelError::new(codes::OPERATION_CONFLICT, false, ChannelOutcome::NotApplied, "host mapping conflicts with the prepared intent"));
                        }
                        matches!(adapter.commit_outcome(&intent_key, Some(&mapping.block_id), None), Ok(()))
                    }
                    Ok(None) => {
                        let request = rebuild_request(&intent, &self.config, &*self.clock)?;
                        matches!(
                            adapter.submit(&request),
                            Ok(IngressSubmitReceipt::Committed { .. })
                        )
                    }
                    Err(_) => false,
                }
            };
            if !terminal {
                remaining += 1;
            }
        }
        Ok(remaining)
    }

    /// Resume one `prepared` intent carrying attachment import records:
    /// status-first through the injected seam per attachment, then commit the
    /// final Asset-bearing draft when every required asset is AVAILABLE. A
    /// refused attachment durably rejects the event (never a fabricated
    /// reference); a still-pending import keeps the row `prepared`. Returns
    /// whether the intent reached a terminal state.
    fn resume_attachment_intent(&mut self, mut intent: crate::intent::ChannelIntent) -> Result<bool, ChannelError> {
        let records = intent.attachments.clone();
        let mut refused: Option<String> = None;
        let mut resolved_records: Vec<AttachmentRecord> = Vec::new();
        let mut all_available = true;
        for record in &records {
            if record.state == AttachmentState::Pending {
                let request = AttachmentImportRequest::new(
                    &intent.account,
                    &intent.external_event_id,
                    &record.attachment,
                );
                match self.assets.status(&request) {
                    Ok(AttachmentImportStatus::Available(available)) => {
                        if available.media_type != record.attachment.declared_media_type {
                            // A forged declared media type is an explicit
                            // refusal, never a relabel of active content.
                            refused = Some(codes::MALFORMED_EVENT.to_string());
                            break;
                        }
                        resolved_records.push(AttachmentRecord {
                            attachment: record.attachment.clone(),
                            state: AttachmentState::Available,
                            available: Some(available),
                            refused_code: None,
                        });
                    }
                    Ok(AttachmentImportStatus::Pending) => {
                        resolved_records.push(record.clone());
                        all_available = false;
                    }
                    Ok(AttachmentImportStatus::Refused { code }) => {
                        refused = Some(code);
                        break;
                    }
                    Err(error) => {
                        all_available = false;
                        resolved_records.push(record.clone());
                        let _ = error;
                        break;
                    }
                }
            } else if record.state == AttachmentState::Available {
                resolved_records.push(record.clone());
            } else {
                refused = Some(record.refused_code.clone().unwrap_or_else(|| codes::INTERNAL.to_string()));
                break;
            }
        }
        if let Some(code) = refused {
            // Durable explicit rejection; nothing resubmits.
            let mut adapter = HostIngressCoreAdapter::new(
                &mut self.host,
                self.authority,
                self.grant,
                &mut self.store,
                self.config.revision,
            );
            adapter
                .commit_outcome(&intent.intent_key, None, Some(&code))
                .map_err(|error| {
                    ChannelError::new(
                        codes::INTERNAL,
                        false,
                        ChannelOutcome::NotApplied,
                        format!("attachment refusal durability failed: {error:?}"),
                    )
                })?;
            return Ok(true);
        }
        if !all_available {
            intent.attachments = resolved_records;
            self.store.write_prepared(&intent)?;
            return Ok(false);
        }
        // Every required asset is AVAILABLE: append the ordered Asset parts to
        // the placeholder draft and submit exactly once, then commit terminal.
        let parsed = serde_json::from_str::<serde_json::Value>(&intent.request_jcs).map_err(
            |_| ChannelError::new(codes::INTERNAL, false, ChannelOutcome::NotApplied, "attachment intent placeholder draft is not JSON"),
        )?;
        let mut draft_value = parsed;
        let mut parts = draft_value
            .get("parts")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        for record in resolved_records
            .iter()
            .filter(|record| record.state == AttachmentState::Available)
        {
            if let Some(available) = &record.available {
                let mut part = serde_json::json!({
                    "kind": "asset",
                    "asset_id": available.asset_id,
                    "media_type": available.media_type,
                });
                if let Some(view) = &available.view {
                    part["view"] = serde_json::to_value(view).expect("canonical crop serializes");
                }
                parts.push(part);
            }
        }
        draft_value["parts"] = serde_json::Value::Array(parts);
        let draft = dolly_canonical_json::CanonicalJsonValue::try_from(draft_value).map_err(|_| {
            ChannelError::new(codes::INTERNAL, false, ChannelOutcome::NotApplied, "final attachment draft is not canonical JSON")
        })?;
        let request = IngressSubmitRequest {
            operation_id: ids::operation_id(&intent.account, &intent.external_event_id, 2),
            module_id: intent.module_id.clone(),
            idempotency_key: intent.intent_key.clone(),
            draft: draft.clone(),
            target_page_ids: intent.target_page_ids.clone(),
            deadline: crate::clock::timestamp_plus_seconds(
                self.clock.now().as_str(),
                self.config.operation_deadline_seconds as i64,
            ),
        };
        // Re-derive the FINAL intent (digest bound to the Asset-bearing draft)
        // and persist it BEFORE the Host submit, so the seam's submit
        // idempotency comparison sees the byte-identical request and never a
        // digest conflict against the placeholder draft. A lost response then
        // leaves the final prepared intent for the next status-first pass
        // (no duplicate effect, no fabricated reference).
        let facts = crate::host_adapter::channel_facts_from_draft(&request.draft).map_err(|error| {
            ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::NotApplied,
                format!("final attachment draft facts unavailable: {error:?}"),
            )
        })?;
        let mut final_intent = crate::host_adapter::prepare_intent(
            &self.principal,
            self.config.revision,
            &request,
            &facts,
        )?;
        final_intent.attachments = resolved_records;
        self.store.replace_pending_attachment_intent(&final_intent)?;
        let submitted = {
            let mut adapter = HostIngressCoreAdapter::new(
                &mut self.host,
                self.authority,
                self.grant,
                &mut self.store,
                self.config.revision,
            );
            adapter.submit(&request)
        };
        match submitted {
            Ok(IngressSubmitReceipt::Committed { commit, .. }) => {
                let mut adapter = HostIngressCoreAdapter::new(
                    &mut self.host,
                    self.authority,
                    self.grant,
                    &mut self.store,
                    self.config.revision,
                );
                adapter
                    .commit_outcome(&final_intent.intent_key, Some(&commit.block_id), None)
                    .map_err(|error| {
                        ChannelError::new(
                            codes::INTERNAL,
                            false,
                            ChannelOutcome::NotApplied,
                            format!("attachment intent terminal commit failed: {error:?}"),
                        )
                    })?;
                Ok(true)
            }
            _ => {
                // Unknown/lost: the FINAL prepared intent stays (never a
                // duplicate effect) for the next status-first pass.
                Ok(false)
            }
        }
    }
}



fn rebuild_request(
    intent: &crate::intent::ChannelIntent,
    config: &ChannelConfig,
    clock: &dyn Clock,
) -> Result<IngressSubmitRequest, ChannelError> {
    let parsed = serde_json::from_str::<serde_json::Value>(&intent.request_jcs)
        .map_err(|_| ChannelError::new(codes::INTERNAL, false, ChannelOutcome::NotApplied, "prepared intent draft is not JSON"))?;
    let draft = dolly_canonical_json::CanonicalJsonValue::try_from(parsed)
        .map_err(|_| ChannelError::new(codes::INTERNAL, false, ChannelOutcome::NotApplied, "prepared intent draft is not canonical JSON"))?;
    Ok(IngressSubmitRequest {
        operation_id: ids::operation_id(&intent.account, &intent.external_event_id, 2),
        module_id: intent.module_id.clone(),
        idempotency_key: intent.intent_key.clone(),
        draft,
        target_page_ids: intent.target_page_ids.clone(),
        deadline: crate::clock::timestamp_plus_seconds(clock.now().as_str(), config.operation_deadline_seconds as i64),
    })
}
