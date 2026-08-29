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
use crate::host_adapter::{HostIngressCoreAdapter, channel_intent_digest, payload_digest_of};
use crate::ids;
use crate::ingress::{
    CoreIngress, CoreIngressError, IngressOutcome, IngressStatusResult, IngressSubmitReceipt,
    IngressSubmitRequest, InboundEvent, process_event,
};
use crate::intent::IntentState;
use crate::ledger::ChannelLedger;
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
        let store = SqliteChannelStore::new(connection, &principal)?;
        Ok(Self { config, clock, store, host, authority, grant, principal })
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
        store.verify_owner_against(&principal)?;
        Ok(Self { config, clock, store, host, authority, grant, principal })
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
        //    conflicts BEFORE any Core path is reached.
        if let Ok(Some(intent)) = self.store.find_intent(&intent_key) {
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
            }
        }

        // 3. The accepted pipeline runs with a fresh adapter over the owned
        //    store. Suppress a durable sent-transport echo before Host/Core
        //    via the projection seeded with echo markers.
        let mut ledger = ChannelLedger::new();
        let outcome = {
            if let Ok(projected) = self.store.project_ledger() {
                ledger = projected;
            }
            let mut adapter = HostIngressCoreAdapter::new(
                &mut self.host,
                self.authority,
                self.grant,
                &mut self.store,
                self.config.revision,
            );
            process_event(&self.config, &*self.clock, &mut ledger, &mut adapter, &inbound)
        };

        // 4. A replay must still revalidate the CURRENT authority/grant and
        //    status before acknowledging.
        match outcome {
            IngressOutcome::IdempotentReplay { block_id } => {
                let mut adapter = HostIngressCoreAdapter::new(
                    &mut self.host,
                    self.authority,
                    self.grant,
                    &mut self.store,
                    self.config.revision,
                );
                match adapter.status_for_event(&inbound.external_message_id) {
                    Ok(IngressStatusResult::Committed { commit }) if commit.block_id == block_id => {
                        IngressOutcome::IdempotentReplay { block_id }
                    }
                    Ok(IngressStatusResult::Committed { .. }) => IngressOutcome::RejectedBeforeMutation {
                        error: ChannelError::new(codes::LEDGER_CORRUPT, false, ChannelOutcome::NotApplied, "replayed block identity does not match the durable Host mapping"),
                    },
                    Ok(IngressStatusResult::Absent) => IngressOutcome::RejectedBeforeMutation {
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
            other => other,
        }
    }

    /// Reconcile every durable `prepared` intent through `status` first, with
    /// NO event redelivery. Restores the terminal ledger/state exactly once.
    /// Returns the number of intents left unresolved.
    pub fn reconcile(&mut self) -> Result<usize, ChannelError> {
        let pending_keys: Vec<String> = self.store.list_pending()?.into_iter().map(|i| i.intent_key).collect();
        let mut remaining = 0;
        for intent_key in pending_keys {
            let intent = match self.store.find_intent(&intent_key)? {
                Some(intent) => intent,
                None => continue,
            };
            let terminal = {
                let mut adapter = HostIngressCoreAdapter::new(
                    &mut self.host,
                    self.authority,
                    self.grant,
                    &mut self.store,
                    self.config.revision,
                );
                match adapter.status_for_event(&intent.external_event_id) {
                    Ok(IngressStatusResult::Committed { commit }) => {
                        match adapter.commit_outcome(&intent_key, Some(&commit.block_id), None) {
                            Ok(()) => true,
                            Err(_) => false,
                        }
                    }
                    Ok(IngressStatusResult::Absent) => {
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
