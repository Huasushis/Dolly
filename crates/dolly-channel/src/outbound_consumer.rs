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
use std::collections::BTreeMap;
use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority, SqliteCoreStore};
use serde_json::Value;

use crate::clock::Clock;
use crate::config::ChannelConfig;
use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::ledger::{ChannelLedger, OutboundEntry, OutboundState};
use crate::outbound::{SendDispatchResult, build_prepared_entry, transport_and_settle};
use crate::outbound_committed::{CommittedSendAction, committed_send_from_block};
use crate::outbound_queue::BoundedPendingQueue;
use crate::rate_limit::TokenBucket;
use crate::principal::ChannelPrincipal;
use crate::store::{DispatchClaim, DurableOutboundRecord, OutboundPreparedOutcome, SqliteChannelStore};

/// Whether a committed Block is recorded as an ingress operation in the
/// authoritative Core journal/operation snapshot. The snapshot is
/// journal-verified on load, so this makes the selection operation/transition-
/// bound: only Blocks whose commit is recorded in the immutable journal are
/// candidates for targeted send Actions.
fn is_journal_committed(snapshot: &CoreSnapshot, block_id: &str) -> bool {
    snapshot
        .journal
        .iter()
        .any(|event| {
            event.event == "IngressCommitted"
                && event
                    .details
                    .as_ref()
                    .and_then(|details| details.get("block_id"))
                    .and_then(Value::as_str)
                    == Some(block_id)
        })
        || snapshot
            .ingress
            .values()
            .any(|record| record.block_id == block_id)
        || snapshot
            .runtime_events
            .values()
            .any(|record| record.block_id == block_id)
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
    queue: std::sync::Arc<BoundedPendingQueue>,
    /// Per-session token buckets (configured piece rate) applied BEFORE the
    /// dispatch CAS / transport effect.
    rate_buckets: BTreeMap<String, TokenBucket>,
    authority: &'principal HostConnectionAuthority,
    grant: &'principal HostCapabilityGrant,
    principal: ChannelPrincipal,
}

impl<'store, 'core, 'principal> OutboundConsumer<'store, 'core, 'principal> {
    /// Bind the consumer to the opaque current Host authority and capability
    /// grant, open the module-scoped store under the same principal, open the
    /// authoritative Runtime Core snapshot reader, and build the bounded
    /// queue from the configured outbound limits. Every durable effect
    /// re-verifies the full principal against the store.
    pub fn new(
        config: ChannelConfig,
        clock: Box<dyn Clock>,
        module_connection: &'store mut rusqlite::Connection,
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
        let queue = std::sync::Arc::new(BoundedPendingQueue::new(
            config.outbound_limits.max_pending_per_session,
            config.outbound_limits.max_pending_total,
        ));
        Ok(Self {
            config,
            clock,
            store,
            core,
            transport,
            queue,
            rate_buckets: BTreeMap::new(),
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
        let queue = std::sync::Arc::new(BoundedPendingQueue::new(
            config.outbound_limits.max_pending_per_session,
            config.outbound_limits.max_pending_total,
        ));
        Ok(Self {
            config,
            clock,
            store,
            core,
            transport,
            queue,
            rate_buckets: BTreeMap::new(),
            authority,
            grant,
            principal,
        })
    }

    /// The shared bounded queue (worker sharing seam).
    pub fn queue(&self) -> std::sync::Arc<BoundedPendingQueue> {
        std::sync::Arc::clone(&self.queue)
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
        let mut ledger = self.store.project_ledger()?;
        let mut outcomes = Vec::new();
        for action in actions {
            outcomes.push(self.process_committed(&mut ledger, &action, caller_deadline)?);
        }
        Ok(outcomes)
    }

    /// Select the committed, targeted `org.dolly.channel.send` Actions from
    /// the authoritative immutable Core journal/operation snapshot, bound to
    /// the exact sealed principal. Only Blocks whose commit is recorded in
    /// the journal and whose body carries a channel send Action targeting the
    /// configured module are returned; everything else is skipped (never
    /// caller-shaped, never a generic Block scan).
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
        let mut actions = Vec::new();
        for (block_id, block) in &snapshot.blocks {
            // Operation/transition-bound: the Block must be recorded by an
            // ingress/runtime journal operation in the immutable snapshot.
            if !is_journal_committed(&snapshot, block_id) {
                continue;
            }
            if !block_has_send_action(block) {
                continue;
            }
            match committed_send_from_block(block_id, block, &self.principal, &self.config, &ledger) {
                Ok(action) => actions.push(action),
                Err(_) => {
                    // A Block carrying a channel send name but failing the
                    // sealed authority/contract/session validation is not a
                    // consumable targeted Action. It is skipped (zero effect),
                    // never enqueued or transported.
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
                        let mut entry = record.entry.clone();
                        for piece in entry.pieces.iter_mut() {
                            let id = message_ids
                                .get(piece.ordinal as usize)
                                .cloned()
                                .unwrap_or_else(|| format!("confirmed-{}", piece.ordinal));
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
                    crate::transport::TransportStatusResult::Partial { pieces } => {
                        let mut entry = record.entry.clone();
                        for obs in pieces {
                            if let Some(piece) = entry.pieces.iter_mut().find(|p| p.ordinal == obs.ordinal()) {
                                match obs {
                                    crate::transport::TransportPieceOutcome::Confirmed { message_id, .. } => {
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

    fn process_committed(
        &mut self,
        ledger: &mut ChannelLedger,
        committed: &CommittedSendAction,
        caller_deadline: &str,
    ) -> Result<ConsumerOutcome, ChannelError> {
        // 1. Atomic insert/replay/conflict: the exact action key + operation
        //    digest is durably persisted as `Prepared` in one SQLite
        //    transaction (INSERT ... ON CONFLICT DO NOTHING). A fresh key
        //    inserts; an existing key with the same digest replays (terminal
        //    returns the frozen result with zero re-dispatch, non-terminal is
        //    returned unchanged); a different digest conflicts before enqueue
        //    and changes nothing. The durable idempotency key is always
        //    present (item 3) and the transport is status-capable (item 2).
        let prepared = self.build_prepared_record(&committed);
        match self.store.insert_prepared_or_replay(&prepared) {
            Ok(OutboundPreparedOutcome::ReplayTerminal { state, result_jcs }) => {
                return Ok(ConsumerOutcome::Terminal {
                    action_id: committed.action.action_id.clone(),
                    state,
                    result_jcs,
                });
            }
            Ok(OutboundPreparedOutcome::Prepared | OutboundPreparedOutcome::PreparedExisting) => {}
            Err(error) if error.code == codes::OPERATION_CONFLICT => {
                return Ok(ConsumerOutcome::Rejected {
                    action_id: committed.action.action_id.clone(),
                    error,
                });
            }
            Err(error) => return Err(error),
        }

        // 2a. Surviving durable row: only a `Prepared`/`Queued` row may be
        //    dispatched. A `Dispatched`/terminal row is owned by status-first
        //    recovery and must never re-enter the queue or the transport.
        let durable = self
            .store
            .find_outbound(&committed.action.action_id)?
            .expect("durable outbound row");
        if !durable.entry.state.is_dispatchable() {
            return Ok(ConsumerOutcome::Pending {
                action_id: committed.action.action_id.clone(),
            });
        }

        // 2. Bounded queue admission (fair, caller deadline, no leak).
        let session_key = format!("{}\u{0}{}", self.principal.account(), committed.session_id);
        let session = committed.session_id.clone();
        let action_key = committed.action.action_id.clone();
        let max_per = self.config.outbound_limits.max_pending_per_session;
        let max_total = self.config.outbound_limits.max_pending_total;
        if durable.entry.state == OutboundState::Queued {
            // Already durably queued; the dispatch CAS below is the single winner.
        } else {
        let _ = match self.queue.admit(
            || {
                self.store.admit_to_queue(
                    &action_key,
                    &session,
                    max_per,
                    max_total,
                    self.clock.now().as_str(),
                )
            },
            &session_key,
            &action_key,
            crate::clock::timestamp_total_micros(caller_deadline),
            &*self.clock,
        ) {
            Ok(slot) => slot,
            Err(error) => {
                return Ok(ConsumerOutcome::Rejected {
                    action_id: committed.action.action_id.clone(),
                    error,
                })
            }
        };
        }

        // 2b. Configured piece/token rate limiting BEFORE any transport
        //    effect. A rate refusal is deterministic and retryable; the row
        //    stays durably Queued (never leaked) and is claimed on a later
        //    pass when tokens refill.
        {
            let now_micros = crate::clock::timestamp_total_micros(self.clock.now().as_str());
            let bucket = self
                .rate_buckets
                .entry(committed.session_id.clone())
                .or_default();
            if !bucket.try_take(
                now_micros,
                self.config.outbound_limits.max_pieces_per_second_per_session,
                committed.pieces.len() as u64,
            ) {
                return Ok(ConsumerOutcome::Rejected {
                    action_id: committed.action.action_id.clone(),
                    error: crate::error::ChannelError::new(
                        codes::RATE_LIMITED,
                        true,
                        ChannelOutcome::NotApplied,
                        "per-session piece rate exceeded; retry after the bucket refills",
                    ),
                });
            }
        }

        // 3. Atomic dispatch CAS: exactly one claimant wins the
        //    Prepared/Queued -> Dispatched transition. The CAS winner is the
        //    ONLY one authorized to call the transport; all others
        //    (AlreadyDispatched, LostRace) MUST NOT transport and return
        //    Pending for status-first reconciliation. A CAS failure means
        //    zero transport.
        let now = self.clock.now().as_str().to_string();
        let dispatch_claim = self.store.claim_dispatch(&committed.action.action_id, &now);
        match dispatch_claim {
            Ok(DispatchClaim::Won(_won_record)) => {
                // This caller won the CAS: drive the transport + settle.
                // Ensure the in-memory ledger row exists for settle.
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
                        // 4. Atomic terminal+echo commit: the frozen result
                        //    and confirmed transport IDs become durable
                        //    echo-suppression facts in ONE transaction. A
                        //    failure leaves the row Dispatched (uncertain),
                        //    never a terminal-without-marker inconsistency.
                        let entry = ledger
                            .outbound_entry(&committed.action.action_id)
                            .cloned()
                            .expect("settled outbound row");
                        let record = self.build_terminal_record(&committed, &entry);
                        if let Err(error) = self.store.commit_outbound_terminal(&record) {
                                return Err(error);
                        }
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
                        // The transport response was lost; the durable
                        // Dispatched marker is already recorded by the CAS and
                        // the row keeps its durable occupancy until status-
                        // first recovery settles it. The slot marker is a
                        // no-op (durable capacity was consumed at admission).
                        Ok(ConsumerOutcome::Pending {
                            action_id: committed.action.action_id.clone(),
                        })
                    }
                    SendDispatchResult::Rejected(error) => {
                        Err(ChannelError::new(
                            error.code,
                            error.retryable,
                            error.outcome,
                            format!("outbound dispatch failed internally: {}", error.message),
                        ))
                    }
                }
            }
            Ok(DispatchClaim::AlreadyDispatched) | Ok(DispatchClaim::LostRace) => {
                // Another claimant won the CAS or the row was already
                // dispatched: zero transport, return Pending for
                // status-first reconciliation.
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
                Err(error)
            }
        }
    }
}

/// Cheap filter: does this committed block carry any `org.dolly.channel.send`
/// Action at all? Blocks without one are not Channel outbound work.
fn block_has_send_action(block: &Value) -> bool {
    block
        .get("body")
        .and_then(Value::as_object)
        .and_then(|body| body.get("actions"))
        .and_then(Value::as_array)
        .is_some_and(|actions| {
            actions.iter().any(|action| {
                action
                    .get("name")
                    .and_then(Value::as_str)
                    == Some(crate::config::SEND_ACTION_NAME)
            })
        })
}

