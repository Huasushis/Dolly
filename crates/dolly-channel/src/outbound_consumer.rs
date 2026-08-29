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

use dolly_core_reducer::CoreSnapshot;
use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority, SqliteCoreStore};
use serde_json::Value;

use crate::clock::Clock;
use crate::config::ChannelConfig;
use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::ledger::{ChannelLedger, OutboundEntry, OutboundState};
use crate::outbound::{SendDispatchResult, build_prepared_entry, transport_and_settle};
use crate::outbound_committed::CommittedSendAction;
use crate::outbound_queue::OutboundQueueGate;
use crate::principal::ChannelPrincipal;
use crate::store::{DispatchClaim, DurableOutboundRecord, OutboundPreparedOutcome, SqliteChannelStore};


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
    /// Test-support: barrier hook called at every effect boundary
    /// ("after_queue_wait", "before_transport", "before_commit") so fence
    /// changes can be raced deterministically without sleeps.
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
    /// Bind the consumer to the opaque current Host authority and capability
    /// grant, open the module-scoped store under the same principal, open the
    /// authoritative Runtime Core snapshot reader, and build the bounded
    /// queue from the configured outbound limits. Every durable effect
    /// re-verifies the full principal against the store.
    /// Test/dev convenience: builds ONE injected gate for the consumer's
    /// account+config, then delegates to [`Self::new`]. Production callers
    /// MUST inject their own identity-enforced gate (the consumer never
    /// constructs a gate or limiter in the production path).
    #[cfg(feature = "test-support")]
    pub fn new_dev(
        config: ChannelConfig,
        clock: Box<dyn Clock>,
        module_connection: &'store mut rusqlite::Connection,
        runtime_connection: &'core mut rusqlite::Connection,
        transport: Box<dyn crate::transport::ChannelTransport>,
        authority: &'principal HostConnectionAuthority,
        grant: &'principal HostCapabilityGrant,
    ) -> Result<Self, ChannelError> {
        let principal = ChannelPrincipal::from_authority_grant(authority, grant)?;
        let gate = std::sync::Arc::new(OutboundQueueGate::new(
            principal.account(),
            config.outbound_limits,
        ));
        Self::new(
            config,
            clock,
            module_connection,
            runtime_connection,
            gate,
            transport,
            authority,
            grant,
        )
    }

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
        // Identity-enforced gate: the injected gate must belong to the SAME
        // store/account this consumer is bound to. The gate is integrator-
        // owned (ONE per store/account); the consumer never constructs one.
        if gate.account() != principal.account() {
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "injected outbound gate belongs to a different account",
            ));
        }
        let mut config = config;
        config.transport_account = principal.account().to_string();
        let store = SqliteChannelStore::new(module_connection, &principal, config.revision)?;
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
            #[cfg(feature = "test-support")]
            effect_hook: None,
            authority,
            grant,
            principal,
        })
    }

    /// Test-support only: build over a pre-opened store so failpoints can be
    /// injected while enforcing store/principal equality.
    #[cfg(feature = "test-support")]
    pub fn new_with_store(
        config: ChannelConfig,
        clock: Box<dyn Clock>,
        store: SqliteChannelStore<'store>,
        runtime_connection: &'core mut rusqlite::Connection,
        transport: Box<dyn crate::transport::ChannelTransport>,
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
        let gate = std::sync::Arc::new(OutboundQueueGate::new(
            principal.account(),
            config.outbound_limits,
        ));
        Ok(Self {
            config,
            clock,
            store,
            core,
            transport,
            gate,
            #[cfg(feature = "test-support")]
            effect_hook: None,
            authority,
            grant,
            principal,
        })
    }

    /// The single shared gate+limiter seam for worker sharing (SAME account
    /// enforced by identity).
    pub fn gate(&self) -> std::sync::Arc<OutboundQueueGate> {
        std::sync::Arc::clone(&self.gate)
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

    /// One consume pass: re-verify the current sealed authority, read the
    /// authoritative committed Blocks, and for every targeted channel send
    /// Action persist the durable `Prepared` record, admit to the bounded
    /// queue under the caller deadline, dispatch, and atomically commit the
    /// durable result + echo markers. Returns one outcome per processed
    /// Action.
    /// Revalidate the current sealed authority against BOTH the in-memory
    /// principal fences and the authoritative current capability grant in the
    /// Core store (unrevoked, same grant). A revoked grant, a replaced grant
    /// (generation/incarnation/config/graph change), or a fence mismatch
    /// fails closed with `CHANNEL_AUTHENTICATION_FAILED` before any durable
    /// or transport effect.
    fn revalidate_current_grant(&mut self) -> Result<(), ChannelError> {
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
                "the current capability grant changed (generation/lifecycle/config/graph)",
            )),
            None => Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "the capability grant was revoked",
            )),
        }
    }

    pub fn consume(&mut self, caller_deadline: &str) -> Result<Vec<ConsumerOutcome>, ChannelError> {
        // Fresh authority: re-derive the sealed principal and consult the
        // CURRENT grant in the authoritative Core store BEFORE any durable or
        // transport effect. A revoked grant or a changed generation/lifecycle
        // fence refuses the whole pass with zero effect.
        self.revalidate_current_grant()?;
        // Read the authoritative journal-verified Core snapshot and select the
        // committed targeted Actions — never caller-supplied Blocks.
        let actions = self.committed_targeted_actions()?;
        let mut outcomes = Vec::new();
        // PHASE 1: durable admission for each selected Action (insert/
        // replay/conflict + rate + caller-deadline gate). Outcomes that need
        // no transport (replay/conflict/pending/refusal) are emitted here.
        let mut admitted: Vec<CommittedSendAction> = Vec::new();
        for action in &actions {
            match self.admit_one(action, caller_deadline)? {
                AdmitResult::Admitted(admitted_action) => admitted.push(admitted_action),
                AdmitResult::Outcome(outcome) => outcomes.push(outcome),
            }
        }
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


    /// Select the committed, targeted `org.dolly.channel.send` Actions from
    /// the authoritative immutable Core journal/operation snapshot, bound to
    /// the exact sealed principal. Only Blocks whose commit is recorded in
    /// the journal and whose body carries a channel send Action targeting the
    /// configured module are returned; everything else is skipped (never
    /// caller-shaped, never a generic Block scan).
    /// Select the committed, targeted `org.dolly.channel.send` Actions from
    /// the configured Module's persisted ActivationManifest (Commit 1):
    /// iterate `CoreSnapshot.activations[*].manifest` input_items in Manifest
    /// Delivery order, then each Action in `body.actions` order, and construct
    /// [`CommittedSendAction`] only from a frozen committed Block delivered
    /// through a configured input Page. `CoreSnapshot.blocks`, journal,
    /// ingress, runtime_events, and graph-descriptor membership alone never
    /// mint send authority.
    fn committed_targeted_actions(
        &mut self,
    ) -> Result<Vec<CommittedSendAction>, ChannelError> {
        let snapshot = self.core.snapshot().map_err(|error| {
            ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::NotApplied,
                format!("authoritative core snapshot unavailable: {error}"),
            )
        })?;
        let ledger = self.store.project_ledger()?;
        // Configured input Pages for this module (frozen graph bytes are
        // interpretation authority; they never mint identity by themselves).
        let configured_pages = configured_input_pages(&snapshot, &self.config.module_id);
        let mut actions = Vec::new();
        for activation in snapshot.activations.values() {
            let Some(manifest) = &activation.manifest else { continue };
            if manifest.get("module_id").and_then(Value::as_str) != Some(self.config.module_id.as_str()) {
                continue;
            }
            if manifest.get("reason").and_then(Value::as_str) != Some("input") {
                continue;
            }
            let Some(input_items) = manifest.get("input_items").and_then(Value::as_array) else {
                continue;
            };
            for (input_index, item) in input_items.iter().enumerate() {
                // The frozen Block must have been delivered through a
                // configured input Page (an occurrence on a configured Page).
                let delivered_on_configured_page = item
                    .get("occurrences")
                    .and_then(Value::as_array)
                    .map(|occurrences| {
                        occurrences.iter().any(|occ| {
                            occ.get("page_id")
                                .and_then(Value::as_str)
                                .map(|page| configured_pages.contains(page))
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false);
                if !delivered_on_configured_page {
                    continue;
                }
                let Some(actions_in_block) = item
                    .get("block")
                    .and_then(|b| b.get("body"))
                    .and_then(Value::as_object)
                    .and_then(|body| body.get("actions"))
                    .and_then(Value::as_array)
                else {
                    continue;
                };
                for (action_index, action) in actions_in_block.iter().enumerate() {
                    if action.get("name").and_then(Value::as_str)
                        != Some(crate::config::SEND_ACTION_NAME)
                    {
                        continue;
                    }
                    match CommittedSendAction::from_manifest_input(
                        manifest,
                        item,
                        input_index,
                        action_index,
                        &self.principal,
                        &self.config,
                        &ledger,
                    ) {
                        Ok(action) => actions.push(action),
                        Err(_) => {
                            // An input carrying a channel send name but failing
                            // the sealed authority/contract/session validation
                            // is skipped (zero effect), never enqueued or
                            // transported.
                        }
                    }
                }
            }
        }
        Ok(actions)
    }

    /// Status-first restart/lost-response recovery of the durable outbound
    /// ledger: never re-dispatches a row that may have reached the
    /// transport, never reports false success, never age-guesses to
    /// `unknown`. Every `Dispatched` row is settled by calling
    /// [`ChannelTransport::status`] with the original idempotency key: the
    /// exact transport-side outcome (confirmed/partial/rejected/unknown)
    /// settles the terminal state. `TransportStatusResult::Unknown` leaves
    /// the row `Dispatched` for the next reconcile (never age-promoted).
    /// Returns the number of durable rows still unresolved.
    pub fn reconcile(&mut self) -> Result<usize, ChannelError> {
        // Fresh authority BEFORE any recovery/effect.
        self.revalidate_current_grant()?;
        let pending = self.store.list_pending_outbound()?;
        let mut remaining = 0;
        for record in pending {
            let action_id = record.outbound_key.clone();
            if record.entry.state == OutboundState::Dispatched {
                // Status-first: query the exact transport-side outcome.
                let status = self.transport.status(
                    &crate::transport::TransportStatusRequest {
                        action_id: action_id.clone(),
                        idempotency_key: record.entry.idempotency_key.clone(),
                    },
                );
                let settled = match status {
                    crate::transport::TransportStatusResult::Confirmed { message_ids } => {
                        // Reject BEFORE frozen-envelope settlement: the status
                        // must carry EXACTLY one real, non-empty, unique
                        // transport id per piece (missing, empty, duplicate,
                        // gapped, or out-of-range IDs are NEVER fabricated).
                        let len_ok = message_ids.len() == record.entry.pieces.len();
                        let no_dup = (1..message_ids.len())
                            .all(|i| !message_ids[..i].contains(&message_ids[i]));
                        let all_ids = len_ok
                            && no_dup
                            && record.entry.pieces.iter().all(|p| {
                                message_ids
                                    .get(p.ordinal as usize)
                                    .map(|id| !id.is_empty())
                                    .unwrap_or(false)
                            });
                        if !all_ids {
                            None
                        } else {
                        let mut entry = record.entry.clone();
                        for piece in entry.pieces.iter_mut() {
                            let id = message_ids[piece.ordinal as usize].clone();
                            piece.transport_message_id = Some(id.clone());
                            piece.outcome = Some(crate::ledger::PieceOutcome::Confirmed {
                                transport_message_id: id,
                            });
                        }
                        // Settle via the shared logic so the frozen result
                        // and echo markers are built identically to the
                        // dispatch path.
                        let mut ledger = self.store.project_ledger()?;
                        if let Some(e) = ledger.outbound.get_mut(&action_id) {
                            *e = entry;
                        }
                        let result = crate::outbound::settle_from_outbound_entry(
                            &self.config, &mut ledger, &action_id,
                            self.clock.now().as_str(),
                        );
                        match result {
                            crate::outbound::SendDispatchResult::Terminal { .. } => {
                                ledger.outbound_entry(&action_id).cloned()
                            }
                            _ => None,
                        }
                        }
                    }
                    crate::transport::TransportStatusResult::Partial { pieces } => {
                        if pieces.len() != record.entry.pieces.len() {
                            // Gapped/out-of-range per-piece outcomes: reject
                            // the whole settle before envelope settlement.
                            None
                        } else {
                        let mut entry = record.entry.clone();
                        let mut reject_partial = false;
                        let mut confirmed_ids: Vec<String> = Vec::new();
                        for obs in pieces {
                            if let Some(piece) = entry.pieces.iter_mut().find(|p| p.ordinal == obs.ordinal()) {
                                match obs {
                                    crate::transport::TransportPieceOutcome::Confirmed { message_id, .. } => {
                                        if message_id.is_empty() || confirmed_ids.contains(&message_id) {
                                            // Malformed/duplicate id: reject the
                                            // whole settle (never fabricate).
                                            reject_partial = true;
                                            continue;
                                        }
                                        confirmed_ids.push(message_id.clone());
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
                        // Settle via the shared settle logic (partial/failed/unknown).
                        let mut ledger = self.store.project_ledger()?;
                        if let Some(e) = ledger.outbound.get_mut(&action_id) {
                            *e = entry;
                        }
                        if reject_partial {
                            None
                        } else {
                        let result = crate::outbound::settle_from_outbound_entry(
                            &self.config, &mut ledger, &action_id,
                            self.clock.now().as_str(),
                        );
                        match result {
                            crate::outbound::SendDispatchResult::Terminal { .. } => {
                                ledger.outbound_entry(&action_id).cloned()
                            }
                            _ => None,
                        }
                        }
                        }
                    }
                    crate::transport::TransportStatusResult::Rejected { code } => {
                        // Settle through the shared frozen envelope builder:
                        // a terminal failure must carry the exact result_jcs,
                        // never a fabricated terminal row without one.
                        let mut entry = record.entry.clone();
                        for piece in entry.pieces.iter_mut() {
                            if piece.outcome.is_none() {
                                piece.outcome = Some(crate::ledger::PieceOutcome::Rejected { code: code.clone() });
                            }
                        }
                        let mut ledger = self.store.project_ledger()?;
                        if let Some(e) = ledger.outbound.get_mut(&action_id) {
                            *e = entry;
                        }
                        let result = crate::outbound::settle_from_outbound_entry(
                            &self.config, &mut ledger, &action_id,
                            self.clock.now().as_str(),
                        );
                        match result {
                            crate::outbound::SendDispatchResult::Terminal { .. } => {
                                ledger.outbound_entry(&action_id).cloned()
                            }
                            _ => None,
                        }
                    }
                    crate::transport::TransportStatusResult::Unknown => {
                        // The transport does not know; the row stays
                        // Dispatched. Never age-guess, never resend.
                        None
                    }
                };
                if let Some(entry) = settled {
                    // Fresh authority immediately before the recovery effect.
                    self.revalidate_current_grant()?;
                    let terminal_record = self.build_terminal_record_from_entry(&record, &entry);
                    self.store.commit_outbound_terminal(&terminal_record)?;
                } else {
                    remaining += 1;
                }
            } else {
                // Prepared/Queued rows: owned by consume (never dispatched).
                remaining += 1;
            }
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
    fn build_prepared_record(
        &self,
        committed: &CommittedSendAction,
    ) -> DurableOutboundRecord {
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
            input_index: committed.input_index,
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

    /// The durable record for the settled terminal entry (same authority and
    /// committed Action bytes as the original).
    fn build_terminal_record(
        &self,
        committed: &CommittedSendAction,
        entry: &OutboundEntry,
    ) -> DurableOutboundRecord {
        let mut record = self.build_prepared_record(committed);
        record.entry = entry.clone();
        record
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
        // 1b. Fresh authority immediately after the durable prepare.
        self.revalidate_current_grant()?;
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
        // 2b. Configured piece/token rate limiting (one combined limiter in
        //    the gate). A rate refusal is deterministic + retryable; the row
        //    stays Prepared (never queued, never leaked) and is re-attempted
        //    on a later pass.
        if durable.entry.state == OutboundState::Prepared {
            if let Err(error) = self.gate.admit_rate(
                &committed.session_id,
                committed.pieces.len() as u64,
                crate::clock::timestamp_total_micros(self.clock.now().as_str()),
            ) {
                return Ok(AdmitResult::Outcome(ConsumerOutcome::Rejected {
                    action_id: committed.action.action_id.clone(),
                    error,
                }));
            }
        }
        // 2c. Caller-deadline durable admission via the SINGLE gate (combined
        //    occupancy bound + ticket FIFO + exact deadline). A row already
        //    Queued (prior pass) skips re-admission and proceeds to the CAS.
        if durable.entry.state == OutboundState::Prepared {
            let session_key = format!("{}\u{0}{}", self.principal.account(), committed.session_id);
            let session = committed.session_id.clone();
            let action_key = committed.action.action_id.clone();
            match self.gate.admit(
                &mut self.store,
                &session_key,
                &session,
                &action_key,
                crate::clock::timestamp_total_micros(caller_deadline),
                &*self.clock,
            ) {
                Ok(_slot) => {}
                Err(error) => {
                    return Ok(AdmitResult::Outcome(ConsumerOutcome::Rejected {
                        action_id: committed.action.action_id.clone(),
                        error,
                    }));
                }
            }
        }
        // 2d. Fresh authority AFTER the queue wait AND deadline recheck: a
        //    grant revoked while this admission waited, or a deadline burned
        //    past the admit attempt, refuses the effect immediately. The row
        //    (if just admitted) stays durably Queued and is drained by FIFO
        //    on a later claim; zero transport now.
        self.effect_ts("after_queue_wait");
        self.revalidate_current_grant()?;
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

    /// Phase 2: claim the dispatch CAS for one durably-Queued row and drive
    /// transport + settle. Exactly one concurrent claimant wins; the winner
    /// is the only caller of the transport. Terminal commit releases durable
    /// occupancy and wakes every waiting admission (C).
    fn dispatch_admitted(
        &mut self,
        ledger: &mut ChannelLedger,
        committed: &CommittedSendAction,
        _durable: &DurableOutboundRecord,
    ) -> Result<ConsumerOutcome, ChannelError> {
        // Fresh authority IMMEDIATELY before the transport effect.
        self.revalidate_current_grant()?;
        let now = self.clock.now().as_str().to_string();
        let dispatch_claim = self.store.claim_dispatch(&committed.action.action_id, &now);
        match dispatch_claim {
            Ok(DispatchClaim::Won(_won_record)) => {
                // This caller won the CAS: drive the transport + settle.
                if ledger.outbound_entry(&committed.action.action_id).is_none() {
                    let entry = build_prepared_entry(
                        &self.config,
                        &*self.clock,
                        &committed.action,
                        &committed.session_id,
                        committed.pieces.clone(),
                        true,
                    );
                    let _ = ledger.insert_outbound(
                        entry,
                        self.config.ledger_bounds.outbound_max_entries,
                    );
                }
                let result = transport_and_settle(
                    &self.config,
                    ledger,
                    &mut *self.transport,
                    &committed.action.action_id,
                    &now,
                    true,
                );
                match result {
                    SendDispatchResult::Terminal { state, result } => {
                        let entry = ledger
                            .outbound_entry(&committed.action.action_id)
                            .cloned()
                            .expect("settled outbound row");
                        let record = self.build_terminal_record(committed, &entry);
                        // Fresh authority immediately before the recovery/
                        // result effect.
                        self.effect_ts("before_commit");
                        self.revalidate_current_grant()?;
                        self.store.commit_outbound_terminal(&record)?;
                        // Terminal release frees durable occupancy; wake every
                        // waiting admission.
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
                    SendDispatchResult::DispatchedPending => {
                        // Transport response lost; the durable row stays
                        // Dispatched (occupancy held) until status-first
                        // recovery settles it.
                        Ok(ConsumerOutcome::Pending {
                            action_id: committed.action.action_id.clone(),
                        })
                    }
                    SendDispatchResult::Rejected(error) => Err(ChannelError::new(
                        error.code,
                        error.retryable,
                        error.outcome,
                        format!("outbound dispatch failed internally: {}", error.message),
                    )),
                }
            }
            Ok(DispatchClaim::AlreadyDispatched) | Ok(DispatchClaim::LostRace) => {
                // Another claimant won or the row was already dispatched: zero
                // transport, Pending for status-first recovery.
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
fn configured_input_pages(snapshot: &CoreSnapshot, module_id: &str) -> std::collections::BTreeSet<String> {
    let document = snapshot
        .graph
        .get("graph")
        .unwrap_or(&snapshot.graph);
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
