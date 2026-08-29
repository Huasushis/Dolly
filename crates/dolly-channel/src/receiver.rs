//! Durable Channel inbound receiver (G4-C wiring).
//!
//! The receiver is the shipping-runtime entry point for one already
//! authenticated Channel event. Direction is preserved end to end:
//!
//! ```text
//! authenticated transport event (sealed under the Host authority/grant)
//!   -> validate principal + bind account/fences against current sealed
//!      HostConnectionAuthority + HostCapabilityGrant (before any replay/ack)
//!   -> durable prepared Channel intent (module-scoped SQLite, BEFORE any
//!      Host submit or Core effect)
//!   -> sealed B Host ingress premise
//!   -> Core exactly once
//! ```
//!
//! The receiver never accepts an identity claim from a caller: the transport
//! event is the opaque [`AuthenticatedChannelEvent`] (produced only under the
//! sealed authority/grant), every authoritative fact is derived from the
//! current sealed principal, and the free `ChannelConfig` is bound to that
//! principal at construction (extension, module, and the derived account).
//! Replays revalidate the current authority/grant and `status` first — never
//! a cached success under a stale or revoked authority. A crash or lost
//! response after a Host commit reopens the durable intent row, asks `status`
//! first, and converges without a duplicate effect or a false success.

use dolly_core_domain::Timestamp;
use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority, HostIngress};

use crate::clock::{Clock, timestamp_plus_seconds};
use crate::config::ChannelConfig;
use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::host_adapter::{HostIngressCoreAdapter, channel_intent_digest, payload_digest_of};
use crate::ids;
use crate::ingress::{
    CoreIngress, CoreIngressError, InboundEvent, IngressOutcome, IngressStatusResult,
    IngressSubmitReceipt, IngressSubmitRequest, process_event,
};
use crate::intent::{ChannelIntent, IntentState};
use crate::ledger::{ChannelLedger, InboundState};
use crate::principal::ChannelPrincipal;
use crate::store::ChannelStore;

/// The raw, transport-supplied content of one authenticated Channel event.
///
/// This struct carries only message content — never an account, owner, fence,
/// or target claim. Every authoritative field is derived from the sealed
/// Host authority and capability grant when the event is constructed or
/// ingested.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelEventContent {
    pub channel_id: String,
    /// Transport kind (`web`, `cli`, `test-harness`, ...).
    pub transport: String,
    pub external_conversation_id: String,
    pub external_message_id: String,
    pub sender_class: String,
    pub sender_id: String,
    pub text: String,
    pub received_at: Timestamp,
    pub event_kind: crate::ledger::EventKind,
    /// For edit/delete events: the referenced original external message ID.
    pub references_external_message_id: Option<String>,
}

/// An opaque, already-authenticated Channel transport event.
///
/// The upstream registration adapter (which alone holds the sealed current
/// Host authority and capability grant) constructs these events; the fields
/// are private and the struct implements no deserializer, so a caller can
/// neither fabricate nor reuse a principal claim. The receiver rebinds and
/// re-verifies the CURRENT authority/grant and `status` before any replay or
/// acknowledgement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedChannelEvent {
    /// The principal-derived account this event was bound to at
    /// construction; the receiver refuses the event if it does not match the
    /// current principal's account.
    account: String,
    content: ChannelEventContent,
}

impl AuthenticatedChannelEvent {
    /// Seal one authenticated transport event under the opaque current Host
    /// authority and capability grant. The owner/account and every fence are
    /// derived from the sealed principal; the caller supplies message content
    /// only.
    pub fn new(
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
        content: ChannelEventContent,
    ) -> Result<Self, ChannelError> {
        let principal = ChannelPrincipal::from_authority_grant(authority, grant)?;
        Ok(Self {
            account: principal.account().to_string(),
            content,
        })
    }

    /// The principal-derived account this event was bound to at construction.
    pub(crate) fn bound_account(&self) -> &str {
        &self.account
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
/// `HostIngress` implementation.
pub struct InboundReceiver<'principal, S: ChannelStore, H: HostIngress> {
    config: ChannelConfig,
    clock: Box<dyn Clock>,
    ledger: ChannelLedger,
    store: S,
    host: H,
    authority: &'principal HostConnectionAuthority,
    grant: &'principal HostCapabilityGrant,
}

impl<'principal, S: ChannelStore, H: HostIngress> InboundReceiver<'principal, S, H> {
    /// Load the durable ledger from the module-scoped store (an empty ledger
    /// on first use) and bind the receiver to the opaque current Host
    /// authority and capability grant.
    ///
    /// The free configuration is bound to the sealed principal here: the
    /// Extension and Module MUST equal the granted ones, and the effective
    /// transport account is REPLACED by the authority-derived account (a
    /// caller cannot choose a deduplication namespace).
    pub fn new(
        config: ChannelConfig,
        clock: Box<dyn Clock>,
        mut store: S,
        host: H,
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
        let ledger = store.load()?;
        Ok(Self {
            config,
            clock,
            ledger,
            store,
            host,
            authority,
            grant,
        })
    }

    /// The current in-memory Channel ledger (mirrors the durable document
    /// after every acknowledged call).
    pub fn ledger(&self) -> &ChannelLedger {
        &self.ledger
    }

    /// Process one sealed, already-authenticated event through the accepted
    /// pipeline with the pre-effect intent ordering described at the module
    /// top.
    pub fn ingest_event(&mut self, event: &AuthenticatedChannelEvent) -> IngressOutcome {
        let Self {
            config,
            clock,
            ledger,
            store,
            host,
            authority,
            grant,
        } = self;

        // 1. Bind against the CURRENT sealed authority/grant before any
        //    replay or acknowledgement.
        let principal = match ChannelPrincipal::from_authority_grant(authority, grant) {
            Ok(principal) => principal,
            Err(error) => {
                return IngressOutcome::RejectedBeforeMutation { error };
            }
        };
        if event.bound_account() != principal.account() {
            return IngressOutcome::RejectedBeforeMutation {
                error: ChannelError::new(
                    codes::AUTHENTICATION_FAILED,
                    false,
                    ChannelOutcome::NotApplied,
                    "the event is bound to a different authenticated principal",
                ),
            };
        }

        let inbound = event
            .clone()
            .into_inbound_event(principal.account().to_string());
        let intent_key =
            ids::inbound_ingress_key(principal.account(), &inbound.external_message_id);

        // 2. Pre-replay conflict and prior-rejection binding against the
        //    durable intent: the Channel-local digest includes the ordered
        //    target Pages, so a same-key replay whose targets/order changed
        //    conflicts BEFORE any Core path is reached.
        let pre_intent = match store.find_intent(&intent_key) {
            Ok(intent) => intent,
            Err(error) => return IngressOutcome::RejectedBeforeMutation { error },
        };
        if let Some(intent) = &pre_intent {
            match intent.state {
                IntentState::Rejected => {
                    let code = intent
                        .rejected_code
                        .clone()
                        .unwrap_or_else(|| codes::INTERNAL.to_string());
                    return IngressOutcome::RejectedBeforeMutation {
                        error: ChannelError::new(
                            code,
                            false,
                            ChannelOutcome::NotApplied,
                            "the event key was already durably rejected",
                        ),
                    };
                }
                IntentState::Prepared | IntentState::Accepted => {
                    let current = current_event_digest(
                        &principal,
                        config,
                        intent,
                        &inbound,
                        &config.target_page_ids,
                    );
                    if let Ok(current) = current {
                        if current != intent.digest {
                            return IngressOutcome::RejectedBeforeMutation {
                                error: ChannelError::new(
                                    codes::OPERATION_CONFLICT,
                                    false,
                                    ChannelOutcome::NotApplied,
                                    "the same event key now carries different pages/content/relation",
                                ),
                            };
                        }
                    }
                }
            }
        }

        // 3. The accepted pipeline runs with a fresh adapter; from here on
        //    all module-scoped store access happens through the adapter.
        let outcome = {
            let mut adapter =
                HostIngressCoreAdapter::new(host, authority, grant, &mut *store, config.revision);
            adapter.seed_from_ledger(ledger);

            let outcome = process_event(config, &**clock, ledger, &mut adapter, &inbound);

            // 4. A replay (accepted row, no new Host call) must still
            //    revalidate the CURRENT authority/grant and status before
            //    acknowledging the cached mapping.
            match outcome {
                IngressOutcome::IdempotentReplay { block_id } => {
                    revalidate_replay(&mut adapter, &principal, &inbound, &block_id)
                }
                other => other,
            }
        };

        // 5. Persist the resulting ledger document before acknowledging the
        //    outcome. A persistence failure never fabricates success.
        if store.save(ledger).is_err() {
            return IngressOutcome::SubmissionPending;
        }
        outcome
    }

    /// Reconcile every durable `prepared` intent through `status` first,
    /// using the stored deterministic identity and the current sealed
    /// authority/grant. Returns the number of intents left unresolved, or an
    /// error when the reconciled durable state could not be persisted.
    pub fn reconcile(&mut self) -> Result<usize, ChannelError> {
        let Self {
            config,
            clock,
            ledger,
            store,
            host,
            authority,
            grant,
        } = self;
        let principal = ChannelPrincipal::from_authority_grant(authority, grant)?;

        // All store access happens through the adapter while it lives.
        let pending = store.list_pending()?;
        let (remaining, settled_blocks) = {
            let mut adapter =
                HostIngressCoreAdapter::new(host, authority, grant, &mut *store, config.revision);
            adapter.seed_from_ledger(ledger);
            adapter.seed_from_intents(&pending);

            let mut remaining = 0;
            let mut settled_blocks = Vec::new();
            for intent in pending {
                let settled = match adapter.status_for_event(&intent.external_event_id) {
                    Ok(IngressStatusResult::Committed { commit }) => {
                        adapter.settle_accepted(&intent.intent_key, &commit.block_id)?;
                        Some((intent, commit.block_id))
                    }
                    Ok(IngressStatusResult::Absent) => {
                        // Authoritative absent: replay only the byte-identical
                        // request; the adapter status-firsts before submitting.
                        let request = intent_submit_request(
                            clock.now().as_str(),
                            config.operation_deadline_seconds,
                            &intent,
                        )?;
                        match adapter.submit(&request) {
                            Ok(IngressSubmitReceipt::Committed { commit, .. }) => {
                                Some((intent, commit.block_id))
                            }
                            Err(_) => {
                                remaining += 1;
                                None
                            }
                        }
                    }
                    Err(_) => {
                        // Still unknown: stay prepared, never false success.
                        remaining += 1;
                        None
                    }
                };
                if let Some((intent, block_id)) = settled {
                    let _ = &principal;
                    settled_blocks.push((intent, block_id));
                }
            }
            (remaining, settled_blocks)
        };

        // 6. Reflect settled outcomes into the in-memory ledger and persist.
        for (intent, block_id) in settled_blocks {
            if let Some(entry) = ledger.inbound_get_mut(&intent.account, &intent.external_event_id)
            {
                if entry.state == InboundState::Submitted {
                    entry.state = InboundState::Accepted;
                    entry.block_id = Some(block_id.clone());
                }
            }
        }
        store.save(ledger)?;
        Ok(remaining)
    }
}

/// The Channel-local digest of the CURRENT configuration for one stored
/// intent, so a same-key replay whose ordered target Pages (or any other
/// digest input) changed since the accept conflicts before Core.
fn current_event_digest(
    principal: &ChannelPrincipal,
    config: &ChannelConfig,
    intent: &ChannelIntent,
    inbound: &InboundEvent,
    current_target_page_ids: &[String],
) -> Result<String, ChannelError> {
    let payload_digest = payload_digest_of(&intent.request_jcs);
    Ok(channel_intent_digest(
        principal,
        config.revision,
        &inbound.external_message_id,
        inbound.event_kind,
        inbound.references_external_message_id.as_deref(),
        current_target_page_ids,
        &payload_digest,
    ))
}

/// Revalidate one accepted replay against `status` with the CURRENT sealed
/// authority/grant, so a replay never returns a cached success under a stale
/// or revoked authority.
fn revalidate_replay(
    adapter: &mut HostIngressCoreAdapter<'_, '_, impl HostIngress + ?Sized>,
    _principal: &ChannelPrincipal,
    inbound: &InboundEvent,
    block_id: &str,
) -> IngressOutcome {
    match adapter.status_for_event(&inbound.external_message_id) {
        Ok(IngressStatusResult::Committed { commit }) => {
            if commit.block_id == block_id {
                IngressOutcome::IdempotentReplay {
                    block_id: block_id.to_string(),
                }
            } else {
                IngressOutcome::RejectedBeforeMutation {
                    error: ChannelError::new(
                        codes::LEDGER_CORRUPT,
                        false,
                        ChannelOutcome::NotApplied,
                        "replayed block identity does not match the durable Host mapping",
                    ),
                }
            }
        }
        Ok(IngressStatusResult::Absent) => IngressOutcome::RejectedBeforeMutation {
            error: ChannelError::new(
                codes::LEDGER_CORRUPT,
                false,
                ChannelOutcome::NotApplied,
                "the accepted Channel row has no durable Host mapping",
            ),
        },
        Err(CoreIngressError::Rejected { code }) => IngressOutcome::RejectedBeforeMutation {
            error: ChannelError::new(
                code,
                false,
                ChannelOutcome::NotApplied,
                "the current authority/grant revalidation rejected the replay",
            ),
        },
        Err(_) => IngressOutcome::RejectedBeforeMutation {
            error: ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::NotApplied,
                "the current authority/grant revalidation outcome is unknown",
            ),
        },
    }
}

/// Rebuild the byte-identical submit request of one prepared intent (attempt
/// two), used only after an authoritative `absent`.
fn intent_submit_request(
    now: &str,
    deadline_seconds: u64,
    intent: &ChannelIntent,
) -> Result<IngressSubmitRequest, ChannelError> {
    let parsed = serde_json::from_str::<serde_json::Value>(&intent.request_jcs).map_err(|_| {
        ChannelError::new(
            codes::INTERNAL,
            false,
            ChannelOutcome::NotApplied,
            "prepared intent draft is not JSON",
        )
    })?;
    let draft = dolly_canonical_json::CanonicalJsonValue::try_from(parsed).map_err(|_| {
        ChannelError::new(
            codes::INTERNAL,
            false,
            ChannelOutcome::NotApplied,
            "prepared intent draft is not canonical JSON",
        )
    })?;
    Ok(IngressSubmitRequest {
        operation_id: ids::operation_id(&intent.account, &intent.external_event_id, 2),
        module_id: intent.module_id.clone(),
        idempotency_key: intent.intent_key.clone(),
        draft,
        target_page_ids: intent.target_page_ids.clone(),
        deadline: timestamp_plus_seconds(now, deadline_seconds as i64),
    })
}
